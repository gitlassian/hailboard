from typing import Annotated

import psycopg.errors
from fastapi import APIRouter, Query, Request, Response
from psycopg import sql

from ..auth import AuthMember, CurrentMember, MemberOrPending, Pool
from ..credentials import generate_secret, hash_secret
from ..errors import conflict, forbidden, not_found
from ..joins import agent_added_text, post_activity
from ..membership import (
    board_owner,
    lock_owner,
    notify,
    person_and_agents,
    person_rows,
    record,
    take_off,
)
from ..queries import list_members
from ..ratelimit import JOINS_PER_IP, client_ip, limiter
from ..schemas import (
    MAX_AGENTS_PER_OWNER,
    AddAgentRequest,
    JoinedMember,
    Me,
    MembersResponse,
    OwnerRequest,
    ProfileRequest,
    SecurityEventsResponse,
    SetStatusRequest,
)

router = APIRouter()


@router.get("/me", response_model=Me)
async def me(member: MemberOrPending, pool: Pool):
    """Who the key belongs to. Also answers a member who still waits to be let in."""
    async with pool.connection() as conn:
        cur = await conn.execute(
            """select m.status_text, m.display_name, m.title, m.timezone, b.name as board_name
                 from members m join boards b on b.id = m.board_id
                where m.id = %s""",
            (member.id,),
        )
        row = await cur.fetchone()
        owner = await board_owner(conn, member.board_id)
    return {
        "member": {
            "id": member.id,
            "handle": member.handle,
            "kind": member.kind,
            "owner": member.owner,
            "status_text": row["status_text"] if row else None,
            "role": member.role,
            "state": member.state,
            "display_name": row["display_name"] if row else None,
            "title": row["title"] if row else None,
            "timezone": row["timezone"] if row else None,
        },
        "board": {"id": member.board_id, "name": row["board_name"] if row else ""},
        "board_owner": owner["handle"] if owner else None,
    }


@router.get("/members", response_model=MembersResponse)
async def members(member: CurrentMember, pool: Pool, pending: Annotated[bool, Query()] = False):
    """Who is on the board; with `pending=true`, also who waits for the owner to let them in."""
    return {"members": await list_members(pool, member.board_id, pending=pending)}


def _owner_only(member: AuthMember, what: str) -> None:
    if not member.is_board_owner:
        raise forbidden(f"only the board's owner can {what}")


def _and(handles: list[str]) -> str:
    return handles[0] if len(handles) == 1 else f"{', '.join(handles[:-1])} and {handles[-1]}"


@router.post("/members/{person}/accept", status_code=204)
async def accept(person: str, member: CurrentMember, pool: Pool):
    """Let a person who asked to join onto the board, with their agents. The owner only."""
    _owner_only(member, "let people in")
    async with pool.connection() as conn, conn.transaction():
        await lock_owner(conn, member.id, "let people in")
        rows = await person_rows(conn, member.board_id, person)
        waiting = [r for r in rows if r["state"] == "pending"]
        if not waiting:
            raise not_found(f"{person} is not waiting to join this board")
        await conn.execute(
            """update members set state = 'active', state_at = now(), state_by = %s
                where id = any(%s)""",
            (member.id, [r["id"] for r in waiting]),
        )
        handles = [r["handle"] for r in waiting]
        await notify(
            conn,
            member.board_id,
            member.id,
            f"{member.handle} let {_and(handles)} onto the board.",
            [r["id"] for r in waiting],
        )
        await record(conn, member.board_id, "member_accepted", actor=member.handle, subject=person)
    return Response(status_code=204)


@router.post("/members/{person}/decline", status_code=204)
async def decline(person: str, member: CurrentMember, pool: Pool):
    """Turn down a person who asked to join. Their keys stop working. The owner only."""
    _owner_only(member, "turn people down")
    async with pool.connection() as conn, conn.transaction():
        await lock_owner(conn, member.id, "turn people down")
        rows = await person_rows(conn, member.board_id, person)
        waiting = [r for r in rows if r["state"] == "pending"]
        if not waiting:
            raise not_found(f"{person} is not waiting to join this board")
        await take_off(
            conn, member.board_id, [r["id"] for r in waiting], state="removed", by=member.id
        )
        await post_activity(
            conn, member.board_id, member.id, f"{member.handle} turned down {person}'s request."
        )
        await record(conn, member.board_id, "member_declined", actor=member.handle, subject=person)
    return Response(status_code=204)


@router.delete("/members/{handle:path}", status_code=204)
async def remove(handle: str, member: CurrentMember, pool: Pool):
    """Take someone off the board: a person with all their agents, or one agent.

    The owner can take off anyone but themselves; a person can take off their own agents. Keys
    stop at once, tasks and parts of the project are freed, messages stay in the history.
    """
    person = handle.split("/", 1)[0]
    own_agent = "/" in handle and member.kind == "human" and person == member.handle
    if not (member.is_board_owner or own_agent):
        raise forbidden("only the board's owner can take people off it")
    async with pool.connection() as conn, conn.transaction():
        if not own_agent:
            await lock_owner(conn, member.id, "take people off it")
        rows = await person_rows(conn, member.board_id, person)
        on_board = [r for r in rows if r["state"] in ("active", "pending")]
        target = [r for r in on_board if "/" not in handle or r["handle"] == handle]
        if not target:
            raise not_found(f"{handle} is not on this board")
        if any(r["role"] == "owner" for r in target):
            raise forbidden("the owner cannot be taken off; hand the board over first")
        await take_off(
            conn, member.board_id, [r["id"] for r in target], state="removed", by=member.id
        )
        handles = [r["handle"] for r in target]
        await post_activity(
            conn, member.board_id, member.id, f"{member.handle} took {_and(handles)} off the board."
        )
        await record(
            conn,
            member.board_id,
            "member_removed",
            actor=member.handle,
            subject=handle,
            data={"members": handles},
        )
    return Response(status_code=204)


@router.post("/me/leave", status_code=204)
async def leave(member: CurrentMember, pool: Pool):
    """Leave the board with all your agents. The owner hands the board over first."""
    if member.kind != "human":
        raise forbidden("only a person can leave a board; an agent is taken off by its person")
    if member.is_board_owner:
        raise forbidden("the owner cannot leave; hand the board over first")
    async with pool.connection() as conn, conn.transaction():
        cur = await conn.execute("select role from members where id = %s for update", (member.id,))
        row = await cur.fetchone()
        if row is not None and row["role"] == "owner":
            raise forbidden("the owner cannot leave; hand the board over first")
        ids = await person_and_agents(conn, member.board_id, member.handle)
        await take_off(conn, member.board_id, ids, state="left", by=member.id)
        await post_activity(conn, member.board_id, member.id, f"{member.handle} left the board.")
        await record(conn, member.board_id, "member_left", actor=member.handle)
    return Response(status_code=204)


@router.put("/board/owner", status_code=204)
async def hand_over(body: OwnerRequest, member: CurrentMember, pool: Pool):
    """Hand the board to another person on it. The owner only."""
    _owner_only(member, "hand the board over")
    async with pool.connection() as conn, conn.transaction():
        # Holds the owner's row: a second hand-over at the same time waits, then finds that
        # the caller no longer owns the board.
        await lock_owner(conn, member.id, "hand the board over")
        cur = await conn.execute(
            """select id from members
                where board_id = %s and handle = %s and kind = 'human' and state = 'active'""",
            (member.board_id, body.handle),
        )
        target = await cur.fetchone()
        if target is None:
            raise not_found(f"{body.handle} is not a person on this board")
        if target["id"] == member.id:
            return Response(status_code=204)
        await conn.execute("update members set role = 'member' where id = %s", (member.id,))
        await conn.execute("update members set role = 'owner' where id = %s", (target["id"],))
        await post_activity(
            conn, member.board_id, member.id, f"{member.handle} handed the board to {body.handle}."
        )
        await record(
            conn, member.board_id, "owner_changed", actor=member.handle, subject=body.handle
        )
    return Response(status_code=204)


@router.get("/audit", response_model=SecurityEventsResponse)
async def audit(
    member: CurrentMember,
    pool: Pool,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
):
    """The board's security log, newest first: joins, requests, who was let in or taken off,
    links made and stopped, hand-overs. The owner only."""
    _owner_only(member, "read the security log")
    async with pool.connection() as conn:
        cur = await conn.execute(
            """select kind, actor, subject, data, created_at from security_events
                where board_id = %s order by id desc limit %s""",
            (member.board_id, limit),
        )
        return {"events": await cur.fetchall()}


@router.put("/me/status", status_code=204)
async def set_status(body: SetStatusRequest, member: CurrentMember, pool: Pool):
    async with pool.connection() as conn:
        await conn.execute(
            "update members set status_text = %s where id = %s",
            (body.text or None, member.id),
        )
    return Response(status_code=204)


@router.patch("/me/profile", status_code=204)
async def set_profile(body: ProfileRequest, member: CurrentMember, pool: Pool):
    """Change the person's name, title or time zone. Fields left out stay; null clears one."""
    if member.kind != "human":
        raise forbidden("a profile belongs to a person; an agent shows its work with its status")
    fields = [f for f in ("display_name", "title", "timezone") if f in body.model_fields_set]
    if fields:
        assignments = sql.SQL(", ").join(
            sql.SQL("{} = %s").format(sql.Identifier(f)) for f in fields
        )
        async with pool.connection() as conn:
            await conn.execute(
                sql.SQL("update members set {} where id = %s").format(assignments),
                (*(getattr(body, f) for f in fields), member.id),
            )
    return Response(status_code=204)


@router.post("/agents", status_code=201, response_model=JoinedMember)
async def add_agent(body: AddAgentRequest, request: Request, member: CurrentMember, pool: Pool):
    """Register another agent for the calling person on the same board.

    Only a person can do this (an agent cannot create siblings). The key is shown only once.
    Posts an activity event to the board that says who added which agent.
    """
    if member.kind != "human":
        raise forbidden("only a person can add agents; use your own key, not an agent's")
    limiter(request).check(JOINS_PER_IP, client_ip(request), "join attempts from this address")

    handle = f"{member.handle}/{body.name}"
    api_key = generate_secret("api_key")
    try:
        async with pool.connection() as conn, conn.transaction():
            # Serialise additions for this person so two at once cannot pass the limit together.
            await conn.execute("select 1 from members where id = %s for update", (member.id,))
            cur = await conn.execute(
                """select count(*)::int as n from members
                    where board_id = %s and owner = %s and kind = 'agent' and state = 'active'""",
                (member.board_id, member.handle),
            )
            row = await cur.fetchone()
            if row is not None and row["n"] >= MAX_AGENTS_PER_OWNER:
                raise conflict(f"you already have {MAX_AGENTS_PER_OWNER} agents on this board")
            # An agent of this person's that was taken off comes back under its name: it is the
            # same person's, so nothing of anyone else's comes with it. Its old keys stay stopped.
            cur = await conn.execute(
                """update members
                      set state = 'active', state_at = now(), state_by = %s, disabled_at = null
                    where board_id = %s and handle = %s and owner = %s and kind = 'agent'
                      and state in ('left', 'removed')
                returning id""",
                (member.id, member.board_id, handle, member.handle),
            )
            created = await cur.fetchone()
            if created is None:
                cur = await conn.execute(
                    """insert into members (board_id, handle, kind, owner)
                       values (%s, %s, 'agent', %s) returning id""",
                    (member.board_id, handle, member.handle),
                )
                created = await cur.fetchone()
            assert created is not None
            # The agent's key lives on the machine the person adds it from.
            await conn.execute(
                "insert into api_keys (member_id, key_hash, device) values (%s, %s, %s)",
                (created["id"], hash_secret(api_key), member.device),
            )
            await post_activity(
                conn, member.board_id, member.id, agent_added_text(member.handle, handle)
            )
    except psycopg.errors.UniqueViolation:
        raise conflict(f'"{handle}" is already on this board') from None

    return {"id": created["id"], "handle": handle, "kind": "agent", "api_key": api_key}
