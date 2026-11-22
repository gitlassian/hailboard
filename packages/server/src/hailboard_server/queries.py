"""Queries shared by several routes: messages, inbox, history, members."""

from typing import Any

from psycopg_pool import AsyncConnectionPool

# Columns of a message joined with its author. Use together with MESSAGE_FROM.
# `mentions` lists the members mentioned by handle, `recipients` everyone it was addressed to,
# `seen_by` the recipients it has reached (their read cursor has moved past it), and `files`
# the files sent with it.
MESSAGE_COLUMNS = """
  m.seq,
  a.handle as "from",
  m.kind,
  m.body,
  m.mention_all,
  m.mention_humans,
  m.reply_to_seq,
  m.created_at,
  array(
    select mm.handle
      from message_recipients r
      join members mm on mm.id = r.member_id
     where r.board_id = m.board_id and r.seq = m.seq and r.reason = 'mention'
     order by mm.handle
  ) as mentions,
  array(
    select mm.handle
      from message_recipients r
      join members mm on mm.id = r.member_id
     where r.board_id = m.board_id and r.seq = m.seq
     order by mm.handle
  ) as recipients,
  array(
    select mm.handle
      from message_recipients r
      join members mm on mm.id = r.member_id
     where r.board_id = m.board_id and r.seq = m.seq and mm.inbox_cursor >= m.seq
     order by mm.handle
  ) as seen_by,
  coalesce(
    (select jsonb_agg(
              jsonb_build_object(
                'number', f.number, 'name', f.name, 'size', f.size, 'expires_at', f.expires_at,
                'available', f.content is not null and f.expires_at > now()
              ) order by f.number)
       from files f
      where f.board_id = m.board_id and f.seq = m.seq),
    '[]'::jsonb
  ) as files"""

MESSAGE_FROM = "messages m join members a on a.board_id = m.board_id and a.id = m.author_id"


def to_message(row: dict[str, Any]) -> dict[str, Any]:
    """A database row as the API's message object (the `from` key is an alias in the model)."""
    return {
        "seq": row["seq"],
        "from": row["from"],
        "kind": row["kind"],
        "body": row["body"],
        "mentions": row["mentions"],
        "recipients": row["recipients"],
        "seen_by": row["seen_by"],
        "mention_all": row["mention_all"],
        "mention_humans": row["mention_humans"],
        "reply_to": row["reply_to_seq"],
        "created_at": row["created_at"],
        "files": row["files"],
    }


async def take_inbox(
    pool: AsyncConnectionPool, member_id: str, *, limit: int, ack: bool
) -> dict[str, Any]:
    """Takes the messages addressed to a member that they have not received yet.

    With `ack` the read cursor moves in the same transaction. The member row is locked
    meanwhile, so two concurrent readers (a hook and an MCP call, or two long-polls) take turns
    and never get the same message.
    """
    async with pool.connection() as conn, conn.transaction():
        cur = await conn.execute(
            "select inbox_cursor, state from members where id = %s for update", (member_id,)
        )
        row = await cur.fetchone()
        if row is None or row["state"] != "active":
            # Taken off while waiting for messages: nothing more reaches them.
            return {"messages": [], "remaining": 0}
        after = row["inbox_cursor"]

        cur = await conn.execute(
            f"""select {MESSAGE_COLUMNS}, r.reason
                  from message_recipients r
                  join messages m on m.board_id = r.board_id and m.seq = r.seq
                  join members a on a.board_id = m.board_id and a.id = m.author_id
                 where r.member_id = %s and r.seq > %s
                 order by r.seq
                 limit %s""",
            (member_id, after, limit),
        )
        rows = await cur.fetchall()

        last = rows[-1]["seq"] if rows else after
        if ack and rows:
            await conn.execute(
                "update members set inbox_cursor = %s where id = %s", (last, member_id)
            )
        cur = await conn.execute(
            """select count(*) as count from message_recipients
                where member_id = %s and seq > %s""",
            (member_id, last),
        )
        left = await cur.fetchone()

    return {
        "messages": [{**to_message(r), "reason": r["reason"]} for r in rows],
        "remaining": left["count"] if left else 0,
    }


async def list_messages(
    pool: AsyncConnectionPool,
    board_id: str,
    *,
    after: int | None,
    limit: int,
    before: int | None = None,
) -> dict[str, Any]:
    """Board history, oldest first. Moves no cursor.

    With `after`, the first `limit` messages after it. Otherwise the latest `limit` messages,
    or with `before` the latest ones before that number (for scrolling back).
    """
    async with pool.connection() as conn:
        if after is None:
            cur = await conn.execute(
                f"""select {MESSAGE_COLUMNS} from {MESSAGE_FROM}
                     where m.board_id = %s and (%s::bigint is null or m.seq < %s)
                     order by m.seq desc limit %s""",
                (board_id, before, before, limit),
            )
            rows = list(reversed(await cur.fetchall()))
        else:
            cur = await conn.execute(
                f"""select {MESSAGE_COLUMNS} from {MESSAGE_FROM}
                     where m.board_id = %s and m.seq > %s order by m.seq limit %s""",
                (board_id, after, limit),
            )
            rows = await cur.fetchall()

    next_after = rows[-1]["seq"] if rows else (after or 0)
    return {"messages": [to_message(r) for r in rows], "next_after": next_after}


async def messages_after(
    pool: AsyncConnectionPool, board_id: str, after: int, limit: int
) -> list[dict[str, Any]]:
    async with pool.connection() as conn:
        cur = await conn.execute(
            f"""select {MESSAGE_COLUMNS} from {MESSAGE_FROM}
                 where m.board_id = %s and m.seq > %s order by m.seq limit %s""",
            (board_id, after, limit),
        )
        return [to_message(r) for r in await cur.fetchall()]


async def list_members(
    pool: AsyncConnectionPool, board_id: str, *, pending: bool = False
) -> list[dict[str, Any]]:
    """Who is on the board; with `pending`, also who waits for the owner to let them in."""
    states = ["active", "pending"] if pending else ["active"]
    async with pool.connection() as conn:
        cur = await conn.execute(
            """select m.handle, m.kind, m.status_text, m.last_seen_at, m.last_active_at, m.role,
                      m.state, m.created_at as joined_at,
                      m.inbox_cursor as read_up_to,
                      coalesce(m.last_seen_at > now() - interval '2 minutes', false) as online,
                      m.display_name, m.title, m.timezone,
                      array(select k.device
                              from api_keys k
                             where k.member_id = m.id and k.revoked_at is null
                               and k.device is not null
                             group by k.device
                             order by max(k.last_used_at) desc nulls last, k.device
                      ) as machines
                 from members m
                where m.board_id = %s and m.state = any(%s)
                order by m.handle""",
            (board_id, states),
        )
        return await cur.fetchall()
