"""Who is on a board: letting people in, taking them off, and the log of it.

A person and their agents share one state (see migration 0011). Taking someone off a board stops
their keys and the links they made at once, frees their tasks and parts of the project, and leaves
their messages in the history.
"""

from typing import Any

from psycopg import AsyncConnection
from psycopg.types.json import Jsonb

from .errors import forbidden


async def record(
    conn: AsyncConnection,
    board_id: str,
    kind: str,
    *,
    actor: str | None,
    subject: str | None = None,
    data: dict[str, Any] | None = None,
) -> None:
    """Writes one entry of the board's security log, inside the caller's transaction."""
    await conn.execute(
        """insert into security_events (board_id, actor, kind, subject, data)
           values (%s, %s, %s, %s, %s)""",
        (board_id, actor, kind, subject, Jsonb(data or {})),
    )


async def board_owner(conn: AsyncConnection, board_id: str) -> dict[str, Any] | None:
    """The owner's member row: id and handle."""
    cur = await conn.execute(
        "select id, handle from members where board_id = %s and role = 'owner'", (board_id,)
    )
    return await cur.fetchone()


async def lock_owner(conn: AsyncConnection, member_id: str, what: str) -> None:
    """Checks, inside the caller's transaction, that the member still owns the board, and holds
    their row so that a hand-over cannot run at the same time."""
    cur = await conn.execute(
        "select role, kind from members where id = %s for update", (member_id,)
    )
    row = await cur.fetchone()
    if row is None or row["role"] != "owner" or row["kind"] != "human":
        raise forbidden(f"only the board's owner can {what}")


async def person_rows(conn: AsyncConnection, board_id: str, person: str) -> list[dict[str, Any]]:
    """A person and their agents, locked for the rest of the transaction."""
    cur = await conn.execute(
        """select id, handle, kind, state, role from members
            where board_id = %s and owner = %s
            order by kind desc, handle
            for update""",
        (board_id, person),
    )
    return await cur.fetchall()


async def take_off(
    conn: AsyncConnection, board_id: str, member_ids: list[str], *, state: str, by: str | None
) -> None:
    """Ends membership: the state, the keys, the invite and feed links they made, the tasks and
    parts held."""
    await conn.execute(
        """update members
              set state = %s, state_at = now(), state_by = %s, disabled_at = now(), role = 'member'
            where board_id = %s and id = any(%s)""",
        (state, by, board_id, member_ids),
    )
    await conn.execute(
        "update api_keys set revoked_at = now() where member_id = any(%s) and revoked_at is null",
        (member_ids,),
    )
    # A feed link made by someone who is gone would keep showing them the board, and an invite
    # of theirs would keep bringing people in on their word.
    await conn.execute(
        """update board_tokens
              set revoked_at = now(), revoked_by = (select handle from members where id = %s)
            where board_id = %s and created_by = any(%s) and revoked_at is null""",
        (by, board_id, member_ids),
    )
    await conn.execute(
        "delete from task_agents where board_id = %s and member_id = any(%s)",
        (board_id, member_ids),
    )
    await conn.execute(
        "delete from zones where board_id = %s and member_id = any(%s)", (board_id, member_ids)
    )


async def notify(
    conn: AsyncConnection, board_id: str, author_id: str, body: str, recipient_ids: list[str]
) -> None:
    """A board event that also reaches some members' inboxes, so that their agents hear of it:
    the owner, when someone asks to join; a person, when they are let in."""
    cur = await conn.execute(
        """insert into messages (board_id, author_id, kind, body)
           values (%s, %s, 'activity', %s) returning seq""",
        (board_id, author_id, body),
    )
    row = await cur.fetchone()
    assert row is not None
    if recipient_ids:
        await conn.execute(
            """insert into message_recipients (board_id, seq, member_id, reason)
               select %s, %s, id, 'mention' from unnest(%s::text[]) as id""",
            (board_id, row["seq"], recipient_ids),
        )


async def person_and_agents(conn: AsyncConnection, board_id: str, person: str) -> list[str]:
    """The ids of a person and their agents who are on the board."""
    cur = await conn.execute(
        "select id from members where board_id = %s and owner = %s and state = 'active'",
        (board_id, person),
    )
    return [r["id"] for r in await cur.fetchall()]
