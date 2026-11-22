"""Shared documents: queries used by the member routes and the read-only feed."""

import re
from typing import Any

from psycopg_pool import AsyncConnectionPool

from .errors import invalid
from .schemas import DOCUMENT_NAME_PATTERN, MAX_DOCUMENT_NAME_LENGTH

_NAME = re.compile(DOCUMENT_NAME_PATTERN)

_INFO = """d.name, d.version, char_length(d.body) as size, d.pinned,
           u.handle as updated_by, d.updated_at"""
_FROM = "documents d join members u on u.board_id = d.board_id and u.id = d.updated_by"


def check_name(name: str) -> str:
    if len(name) > MAX_DOCUMENT_NAME_LENGTH or not _NAME.fullmatch(name):
        raise invalid(
            'document name: use letters, digits, ".", "_", "-" and "/" between parts, '
            f'like "plan.md" or "api/users.md", at most {MAX_DOCUMENT_NAME_LENGTH} characters'
        )
    return name


async def list_documents(pool: AsyncConnectionPool, board_id: str) -> list[dict[str, Any]]:
    """The board's documents, pinned ones first, then by name."""
    async with pool.connection() as conn:
        cur = await conn.execute(
            f"""select {_INFO} from {_FROM}
                 where d.board_id = %s order by d.pinned desc, d.name""",
            (board_id,),
        )
        return await cur.fetchall()


async def get_document(
    pool: AsyncConnectionPool, board_id: str, name: str, version: int | None = None
) -> dict[str, Any] | None:
    """The current version, or an earlier one by number. None when there is no such document."""
    async with pool.connection() as conn:
        if version is None:
            cur = await conn.execute(
                f"select {_INFO}, d.body from {_FROM} where d.board_id = %s and d.name = %s",
                (board_id, name),
            )
        else:
            cur = await conn.execute(
                """select v.name, v.version, char_length(v.body) as size, d.pinned,
                          a.handle as updated_by, v.created_at as updated_at, v.body
                     from document_versions v
                     join documents d on d.board_id = v.board_id and d.name = v.name
                     join members a on a.board_id = v.board_id and a.id = v.author_id
                    where v.board_id = %s and v.name = %s and v.version = %s""",
                (board_id, name, version),
            )
        return await cur.fetchone()
