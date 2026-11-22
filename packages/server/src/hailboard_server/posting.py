"""Posting a message: who receives it, and why."""

from typing import Any

from psycopg import AsyncConnection

from .auth import AuthMember
from .errors import invalid
from .mentions import parse_mentions


async def post(
    conn: AsyncConnection,
    member: AuthMember,
    *,
    body: str,
    kind: str,
    reply_to: int | None,
) -> tuple[dict[str, Any], list[str]]:
    """Inserts a message inside the caller's transaction and addresses it.

    @mentions in the text decide who gets it in their inbox, as do a reply and a request for a
    person. Returns the message as the API shows it, and the handles that were mentioned but are
    not on the board.
    """
    mentions = parse_mentions(body)
    to_humans = mentions.humans or kind == "human_request"

    # Who receives the message, and why. The first reason found for a member wins.
    recipients: dict[str, str] = {}
    mentioned: list[str] = []
    unknown: list[str] = []

    if mentions.handles:
        cur = await conn.execute(
            """select id, handle from members
                where board_id = %s and state = 'active' and handle = any(%s)""",
            (member.board_id, mentions.handles),
        )
        id_by_handle = {r["handle"]: r["id"] for r in await cur.fetchall()}
        for handle in mentions.handles:
            member_id = id_by_handle.get(handle)
            if member_id is None:
                unknown.append(handle)
            elif member_id != member.id:
                recipients[member_id] = "mention"
                mentioned.append(handle)

    if to_humans or mentions.all:
        cur = await conn.execute(
            """select id, kind from members
                where board_id = %s and state = 'active' and id <> %s""",
            (member.board_id, member.id),
        )
        others = await cur.fetchall()
        if to_humans:
            for other in others:
                if other["kind"] == "human":
                    recipients.setdefault(other["id"], "human")
        if mentions.all:
            for other in others:
                recipients.setdefault(other["id"], "all")

    if reply_to is not None:
        cur = await conn.execute(
            """select m.author_id, a.state = 'active' as on_board
                 from messages m join members a on a.id = m.author_id
                where m.board_id = %s and m.seq = %s""",
            (member.board_id, reply_to),
        )
        parent = await cur.fetchone()
        if parent is None:
            raise invalid("reply_to: no such message on this board")
        # A reply to someone who is no longer on the board stays on the board for everyone,
        # and reaches nobody's inbox.
        if parent["author_id"] != member.id and parent["on_board"]:
            recipients.setdefault(parent["author_id"], "reply")

    cur = await conn.execute(
        """insert into messages
             (board_id, author_id, kind, body, mention_all, mention_humans, reply_to_seq)
           values (%s, %s, %s, %s, %s, %s, %s)
           returning seq, created_at""",
        (
            member.board_id,
            member.id,
            kind,
            body,
            mentions.all,
            to_humans,
            reply_to,
        ),
    )
    row = await cur.fetchone()
    assert row is not None

    recipient_handles: list[str] = []
    if recipients:
        cur = await conn.execute(
            "select handle from members where id = any(%s) order by handle",
            (list(recipients),),
        )
        recipient_handles = [r["handle"] for r in await cur.fetchall()]
        await conn.execute(
            """insert into message_recipients (board_id, seq, member_id, reason)
               select %s, %s, r.member_id, r.reason
                 from unnest(%s::text[], %s::text[]) as r(member_id, reason)""",
            (member.board_id, row["seq"], list(recipients), list(recipients.values())),
        )

    message = {
        "seq": row["seq"],
        "from": member.handle,
        "kind": kind,
        "body": body,
        "mentions": sorted(mentioned),
        "recipients": recipient_handles,
        "seen_by": [],
        "mention_all": mentions.all,
        "mention_humans": to_humans,
        "reply_to": reply_to,
        "created_at": row["created_at"],
        "files": [],
    }
    return message, unknown
