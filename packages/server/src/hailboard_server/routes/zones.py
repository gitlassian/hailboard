from typing import Annotated

from fastapi import APIRouter, Query, Request, Response

from ..auth import CurrentMember, Pool
from ..errors import forbidden, invalid, not_found
from ..joins import post_activity
from ..paths import normalize
from ..ratelimit import MESSAGES_PER_MEMBER, limiter
from ..schemas import (
    MAX_CHECK_PATHS,
    MAX_ZONES_PER_MEMBER,
    ClaimResult,
    ClaimZoneRequest,
    ZoneCheck,
    ZonesResponse,
)
from ..zones import conflicts_for, describe, get_zone, list_zones, overlaps_with, public

router = APIRouter()


@router.get("/zones", response_model=ZonesResponse)
async def zones(member: CurrentMember, pool: Pool):
    """Every zone on the board: who has taken which part of the project."""
    async with pool.connection() as conn:
        return {"zones": [public(z) for z in await list_zones(conn, member.board_id)]}


@router.get("/zones/check", response_model=ZoneCheck)
async def check(
    member: CurrentMember,
    pool: Pool,
    path: Annotated[list[str], Query(min_length=1, max_length=MAX_CHECK_PATHS)],
):
    """Which of these files sit inside a zone of somebody else. Your own zones never conflict."""
    files = [normalize(p, shown=False) for p in path]
    async with pool.connection() as conn:
        others = await list_zones(conn, member.board_id, except_member=member.id)
    return {"conflicts": conflicts_for(files, others)}


@router.post("/zones", response_model=ClaimResult)
async def claim(
    body: ClaimZoneRequest, request: Request, response: Response, member: CurrentMember, pool: Pool
):
    """Take a part of the project, or change one you already hold under the same name.

    A claim that meets somebody else's zone is still made: the answer lists the overlaps and each
    owner gets a message, so the two can agree on a split. Nothing is refused here: `GET
    /zones/check` is there for a client to ask before it edits a file.
    """
    limiter(request).check(MESSAGES_PER_MEMBER, member.id, "messages from this member")
    paths = list(dict.fromkeys(normalize(p) for p in body.paths))
    name = body.name or paths[0][:80]

    async with pool.connection() as conn, conn.transaction():
        # Serialise this member's claims so two at once cannot pass the limit together.
        await conn.execute("select 1 from members where id = %s for update", (member.id,))
        cur = await conn.execute(
            "select id from zones where board_id = %s and member_id = %s and name = %s",
            (member.board_id, member.id, name),
        )
        existing = await cur.fetchone()
        if existing is None:
            cur = await conn.execute(
                "select count(*)::int as n from zones where board_id = %s and member_id = %s",
                (member.board_id, member.id),
            )
            counted = await cur.fetchone()
            if counted and counted["n"] >= MAX_ZONES_PER_MEMBER:
                raise invalid(
                    f"you hold {MAX_ZONES_PER_MEMBER} zones already: "
                    "release one before taking another"
                )
            cur = await conn.execute(
                """insert into zones (board_id, member_id, name, note, paths)
                   values (%s, %s, %s, %s, %s) returning id""",
                (member.board_id, member.id, name, body.note, paths),
            )
        else:
            cur = await conn.execute(
                """update zones set note = %s, paths = %s, updated_at = now()
                    where id = %s returning id""",
                (body.note, paths, existing["id"]),
            )
        row = await cur.fetchone()
        assert row is not None
        zone = await get_zone(conn, member.board_id, row["id"])
        assert zone is not None

        overlaps = overlaps_with(
            paths, await list_zones(conn, member.board_id, except_member=member.id)
        )
        verb = "took" if existing is None else "changed their claim on"
        await post_activity(
            conn, member.board_id, member.id, f"{member.handle} {verb} {name} ({describe(paths)})."
        )
        await _warn_owners(conn, member.board_id, member.id, member.handle, name, paths, overlaps)

    response.status_code = 201 if existing is None else 200
    return {"zone": public(zone), "overlaps": overlaps}


@router.delete("/zones/{zone_id}", status_code=204)
async def release(zone_id: str, request: Request, member: CurrentMember, pool: Pool):
    """Give a zone up. Only its owner can."""
    limiter(request).check(MESSAGES_PER_MEMBER, member.id, "messages from this member")
    async with pool.connection() as conn, conn.transaction():
        zone = await get_zone(conn, member.board_id, zone_id)
        if zone is None:
            raise not_found("no such zone")
        if zone["member_id"] != member.id:
            raise forbidden(f"only {zone['owner']} can release this zone")
        await conn.execute("delete from zones where id = %s", (zone_id,))
        await post_activity(
            conn, member.board_id, member.id, f"{member.handle} released {zone['name']}."
        )
    return Response(status_code=204)


async def _warn_owners(
    conn, board_id: str, author_id: str, author: str, name: str, paths: list[str], overlaps
) -> None:
    """One ordinary message to each owner whose zone meets the new claim (it reaches the inbox)."""
    by_owner: dict[str, list[dict]] = {}
    for item in overlaps:
        by_owner.setdefault(item["zone"]["owner"], []).append(item)
    for owner, items in by_owner.items():
        meets = "; ".join(f'"{i["zone"]["name"]}" ({describe(i["zone"]["paths"])})' for i in items)
        text = (
            f'@{owner} heads-up: my claim "{name}" ({describe(paths)}) meets your {meets}. '
            "Tell me if we should split it."
        )
        cur = await conn.execute(
            """insert into messages (board_id, author_id, kind, body)
               values (%s, %s, 'message', %s) returning seq""",
            (board_id, author_id, text),
        )
        message = await cur.fetchone()
        await conn.execute(
            """insert into message_recipients (board_id, seq, member_id, reason)
               select %s, %s, id, 'mention' from members
                where board_id = %s and handle = %s and state = 'active'""",
            (board_id, message["seq"], board_id, owner),
        )
