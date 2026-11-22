"""Ownership zones: the parts of a project that agents have taken."""

from typing import Any

from psycopg import AsyncConnection

from .paths import covers, overlaps
from .schemas import ZONE_STALE_HOURS

_STALE = (
    f"coalesce(o.last_seen_at, o.created_at) < now() - make_interval(hours => {ZONE_STALE_HOURS})"
)
_COLUMNS = f"""z.id, z.name, z.note, z.paths, o.handle as owner,
  z.created_at as claimed_at, {_STALE} as stale"""
_FROM = "zones z join members o on o.board_id = z.board_id and o.id = z.member_id"


async def list_zones(
    conn: AsyncConnection, board_id: str, *, except_member: str | None = None
) -> list[dict[str, Any]]:
    """The board's zones, oldest claim first. Zones of members who left are not listed."""
    cur = await conn.execute(
        f"""select {_COLUMNS}, z.member_id from {_FROM}
             where z.board_id = %s and o.state = 'active'
               and (%s::text is null or z.member_id <> %s)
             order by z.created_at, z.id""",
        (board_id, except_member, except_member),
    )
    return await cur.fetchall()


async def get_zone(conn: AsyncConnection, board_id: str, zone_id: str) -> dict[str, Any] | None:
    cur = await conn.execute(
        f"select {_COLUMNS}, z.member_id from {_FROM} where z.board_id = %s and z.id = %s",
        (board_id, zone_id),
    )
    return await cur.fetchone()


def public(zone: dict[str, Any]) -> dict[str, Any]:
    """A zone row without the internal member id."""
    return {k: v for k, v in zone.items() if k != "member_id"}


def overlaps_with(paths: list[str], others: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """For every other zone that meets the given paths: the zone and the paths that meet it."""
    found = []
    for other in others:
        mine = [p for p in paths if any(overlaps(p, theirs) for theirs in other["paths"])]
        if mine:
            found.append({"zone": public(other), "paths": mine})
    return found


def conflicts_for(files: list[str], others: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """For every file: the first other zone that covers it (a file can match several)."""
    found = []
    for file in files:
        for other in others:
            if any(covers(p, file) for p in other["paths"]):
                found.append({"path": file, "zone": public(other)})
                break
    return found


def describe(paths: list[str], limit: int = 4) -> str:
    """A short list of paths for a sentence: "web/checkout/**, web/api.ts and 2 more"."""
    shown = paths[:limit]
    more = len(paths) - len(shown)
    text = ", ".join(shown)
    return f"{text} and {more} more" if more else text
