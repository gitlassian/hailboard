import asyncio
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse
from psycopg_pool import AsyncConnectionPool

from ..auth import Pool
from ..credentials import hash_secret
from ..documents import check_name, get_document, list_documents
from ..errors import ApiError, not_found, unauthorized
from ..pubsub import Waker
from ..queries import list_members, list_messages, messages_after
from ..schemas import (
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
    BoardRef,
    Document,
    DocumentsResponse,
    MemberOut,
    MembersResponse,
    Message,
    MessagesPage,
    Task,
    TasksResponse,
)
from ..tasks import list_tasks, public

router = APIRouter()

PING_EVERY_SECONDS = 15
BACKLOG_LIMIT = 500

Token = Annotated[str, Query(min_length=1)]


async def board_for_read_token(pool: AsyncConnectionPool, token: str) -> str:
    """The board a read token belongs to. Read tokens give read-only access (the web feed)."""
    async with pool.connection() as conn:
        cur = await conn.execute(
            """select board_id from board_tokens
                where token_hash = %s
                  and scope = 'read'
                  and revoked_at is null
                  and (expires_at is null or expires_at > now())""",
            (hash_secret(token),),
        )
        row = await cur.fetchone()
    if row is None:
        raise unauthorized("invalid, expired or revoked read token")
    return row["board_id"]


@router.get("/feed/board", response_model=BoardRef)
async def feed_board(pool: Pool, token: Token):
    """The board a read token belongs to (its name, for the web feed's title)."""
    board_id = await board_for_read_token(pool, token)
    async with pool.connection() as conn:
        cur = await conn.execute("select id, name from boards where id = %s", (board_id,))
        row = await cur.fetchone()
    assert row is not None
    return {"id": row["id"], "name": row["name"]}


@router.get("/feed/messages", response_model=MessagesPage)
async def feed_messages(
    pool: Pool,
    token: Token,
    after: Annotated[int | None, Query(ge=0)] = None,
    before: Annotated[int | None, Query(ge=1)] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = DEFAULT_PAGE_SIZE,
):
    """Read-only history, authenticated with a board read token (for the web feed).

    Without parameters, the latest messages; `before=N` pages back from message N, `after=N`
    forward from it (`after` wins when both are given).
    """
    board_id = await board_for_read_token(pool, token)
    return await list_messages(pool, board_id, after=after, before=before, limit=limit)


@router.get("/feed/members", response_model=MembersResponse)
async def feed_members(pool: Pool, token: Token):
    board_id = await board_for_read_token(pool, token)
    # Machine names are for the people on the board, not for whoever holds a feed link.
    return {"members": [{**m, "machines": []} for m in await list_members(pool, board_id)]}


@router.get("/feed/tasks", response_model=TasksResponse)
async def feed_tasks(pool: Pool, token: Token):
    """The board's tasks with the agents on each, with a read token."""
    board_id = await board_for_read_token(pool, token)
    async with pool.connection() as conn:
        return {"tasks": [public(t) for t in await list_tasks(conn, board_id)]}


@router.get("/feed/docs", response_model=DocumentsResponse)
async def feed_documents(pool: Pool, token: Token):
    """The board's shared documents (without their text), with a read token."""
    board_id = await board_for_read_token(pool, token)
    return {"documents": await list_documents(pool, board_id)}


@router.get("/feed/docs/{name:path}", response_model=Document)
async def feed_document(
    name: str,
    pool: Pool,
    token: Token,
    version: Annotated[int | None, Query(ge=1)] = None,
):
    """One shared document, with a read token."""
    board_id = await board_for_read_token(pool, token)
    found = await get_document(pool, board_id, check_name(name), version)
    if found is None:
        raise not_found(f'no document "{name}"')
    return found


def _sse(event: str, data: str, event_id: int | None = None) -> str:
    head = f"id: {event_id}\n" if event_id is not None else ""
    return f"{head}event: {event}\ndata: {data}\n\n"


@router.get("/stream", response_class=StreamingResponse)
async def stream(
    request: Request,
    pool: Pool,
    token: Token,
    last_event_id: Annotated[int | None, Query(ge=0)] = None,
):
    """Server-Sent Events for the web feed.

    `message` events carry the message number as their id, so after a dropped connection the
    browser reconnects with Last-Event-ID and receives what it missed. Without it the stream
    starts from "now"; load the history from /feed/messages first. `member` events report status
    and presence changes (checked every few seconds), `task` events every task that changed.
    The read token is passed in the query string because the browser's EventSource cannot send an
    Authorization header.
    """
    board_id = await board_for_read_token(pool, token)

    header = request.headers.get("last-event-id")
    if header is not None and header.isdigit():
        last_event_id = int(header)
    if last_event_id is None:
        async with pool.connection() as conn:
            cur = await conn.execute("select last_seq from boards where id = %s", (board_id,))
            row = await cur.fetchone()
        last_event_id = row["last_seq"] if row else 0

    return StreamingResponse(
        _events(request, pool, board_id, last_event_id, token),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _still_valid(pool: AsyncConnectionPool, token: str) -> bool:
    try:
        await board_for_read_token(pool, token)
    except ApiError:
        return False
    return True


async def _events(
    request: Request, pool: AsyncConnectionPool, board_id: str, cursor: int, token: str
) -> AsyncIterator[str]:
    waker = Waker()
    unsubscribe = request.app.state.pubsub.subscribe_board(board_id, waker.signal)
    known: dict[str, str] = {}

    async def member_events() -> list[str]:
        out = []
        for row in await list_members(pool, board_id):
            data = MemberOut.model_validate(row).model_dump_json(exclude={"machines"})
            if known.get(row["handle"]) != data:
                known[row["handle"]] = data
                out.append(_sse("member", data))
        return out

    known_tasks: dict[int, str] = {}

    async def task_events() -> list[str]:
        out = []
        async with pool.connection() as conn:
            rows = await list_tasks(conn, board_id)
        for row in rows:
            data = Task.model_validate(public(row)).model_dump_json()
            if known_tasks.get(row["number"]) != data:
                known_tasks[row["number"]] = data
                out.append(_sse("task", data))
        return out

    async def message_events() -> list[str]:
        nonlocal cursor
        out = []
        while True:
            rows = await messages_after(pool, board_id, cursor, BACKLOG_LIMIT)
            for row in rows:
                data = Message.model_validate(row).model_dump_json(by_alias=True)
                out.append(_sse("message", data, row["seq"]))
                cursor = row["seq"]
            if len(rows) < BACKLOG_LIMIT:
                return out

    try:
        for chunk in await member_events():
            yield chunk
        # The current tasks too; the page applies them over what it loaded.
        for chunk in await task_events():
            yield chunk
        for chunk in await message_events():
            yield chunk
        while True:
            await waker.wait(PING_EVERY_SECONDS)
            if await request.is_disconnected():
                return
            # A revoked or expired link stops the board from reaching a page left open with it.
            if not await _still_valid(pool, token):
                yield _sse("revoked", "{}")
                return
            fresh = await message_events()
            for chunk in fresh:
                yield chunk
            for chunk in await member_events():
                yield chunk
            # Every change to a task posts a board event, so tasks are read again only when
            # messages arrived, not on every ping.
            if fresh:
                for chunk in await task_events():
                    yield chunk
            yield ": ping\n\n"
    except asyncio.CancelledError:
        raise
    finally:
        unsubscribe()
