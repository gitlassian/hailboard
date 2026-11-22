"""Files that members send each other: who may get one, and when its content goes."""

import logging
from typing import Any

from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool

from .auth import AuthMember
from .errors import invalid
from .text import has_control

log = logging.getLogger(__name__)

# A file with what the API shows of it. `mine` says whether the asking member may download it:
# it was sent by, or to, a member with the same owner (a person and that person's agents).
_SELECT = """
select f.id, f.number, f.name, f.size, encode(f.sha256, 'hex') as sha256, f.seq,
       f.created_at, f.expires_at, f.encryption, f.uploaded_by,
       f.content is not null and f.expires_at > now() as available,
       u.handle as "from", u.owner as from_owner,
       array(
         select mm.handle
           from message_recipients r
           join members mm on mm.id = r.member_id
          where r.board_id = f.board_id and r.seq = f.seq
          order by mm.handle
       ) as "to",
       (u.owner = %(owner)s or exists(
         select 1
           from message_recipients r
           join members mm on mm.id = r.member_id
          where r.board_id = f.board_id and r.seq = f.seq and mm.owner = %(owner)s
       )) as mine
  from files f
  join members u on u.board_id = f.board_id and u.id = f.uploaded_by
"""

_INTERNAL = {"id", "uploaded_by", "from_owner", "mine"}


def public(file: dict[str, Any]) -> dict[str, Any]:
    """A file row without what only the server needs."""
    return {k: v for k, v in file.items() if k not in _INTERNAL}


async def get_file(conn: AsyncConnection, member: AuthMember, number: int) -> dict[str, Any] | None:
    cur = await conn.execute(
        f"{_SELECT} where f.board_id = %(board)s and f.number = %(number)s",
        {"owner": member.owner, "board": member.board_id, "number": number},
    )
    return await cur.fetchone()


async def list_files(conn: AsyncConnection, member: AuthMember, limit: int) -> list[dict[str, Any]]:
    """The files the member may download, newest first."""
    cur = await conn.execute(
        f"""select * from ({_SELECT} where f.board_id = %(board)s) x
             where x.mine order by x.number desc limit %(limit)s""",
        {"owner": member.owner, "board": member.board_id, "limit": limit},
    )
    return await cur.fetchall()


# What file systems take as one name.
MAX_NAME_BYTES = 255


def clean_name(name: str) -> str:
    """The name a file is stored and saved under: the last part of a path, nothing that could
    lead out of a folder or hide in a listing."""
    last = name.replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not last or last in {".", ".."} or has_control(last):
        raise invalid("name: a plain file name is needed, like payments.yaml")
    if len(last.encode()) > MAX_NAME_BYTES:
        raise invalid(f"name: at most {MAX_NAME_BYTES} bytes, so that it can be saved anywhere")
    return last


async def expire_files(pool: AsyncConnectionPool) -> int:
    """Drops the content of files whose time is up. The rows stay."""
    async with pool.connection() as conn:
        cur = await conn.execute(
            "update files set content = null where content is not null and expires_at <= now()"
        )
        return cur.rowcount
