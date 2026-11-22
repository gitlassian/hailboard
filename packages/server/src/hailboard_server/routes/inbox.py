import asyncio
from typing import Annotated

from fastapi import APIRouter, Query, Request, Response

from ..auth import CurrentMember, Pool
from ..errors import ApiError
from ..pubsub import Waker
from ..queries import take_inbox
from ..schemas import (
    DEFAULT_PAGE_SIZE,
    DEFAULT_WAIT_SECONDS,
    MAX_PAGE_SIZE,
    MAX_WAIT_SECONDS,
    MAX_WAITS_PER_MEMBER,
    AckInboxRequest,
    InboxResult,
)

router = APIRouter()

Limit = Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)]


@router.get("/inbox", response_model=InboxResult)
async def read_inbox(
    member: CurrentMember,
    pool: Pool,
    limit: Limit = DEFAULT_PAGE_SIZE,
    ack: bool = True,
):
    """Messages addressed to me that I have not received yet.

    With ack=true (the default) the read cursor moves in the same transaction.
    """
    return await take_inbox(pool, member.id, limit=limit, ack=ack)


@router.get(
    "/inbox/wait",
    response_model=InboxResult,
    responses={204: {"description": "Nothing arrived before the timeout; call again."}},
)
async def wait_inbox(
    request: Request,
    member: CurrentMember,
    pool: Pool,
    timeout: Annotated[  # noqa: ASYNC109 - the public query parameter is called `timeout`
        int, Query(ge=1, le=MAX_WAIT_SECONDS)
    ] = DEFAULT_WAIT_SECONDS,
    limit: Limit = DEFAULT_PAGE_SIZE,
):
    """Long-poll: returns as soon as something is addressed to me (200, cursor moved), or 204
    after `timeout` seconds with nothing. The client simply calls it again. The server never
    contacts the client, so this works behind NAT and firewalls."""
    active: dict[str, int] = request.app.state.active_waits
    running = active.get(member.id, 0)
    if running >= MAX_WAITS_PER_MEMBER:
        raise ApiError(
            "rate_limited",
            f"at most {MAX_WAITS_PER_MEMBER} concurrent waits",
            headers={"Retry-After": "5"},
        )
    active[member.id] = running + 1

    # Subscribe before the first read, so a message that arrives in between is not missed.
    waker = Waker()
    unsubscribe = request.app.state.pubsub.subscribe_inbox(member.id, waker.signal)
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout

    try:
        while True:
            if await request.is_disconnected():
                return Response(status_code=204)
            result = await take_inbox(pool, member.id, limit=limit, ack=True)
            if result["messages"]:
                return result
            left = deadline - loop.time()
            if left <= 0:
                return Response(status_code=204)
            # Wake up at least once a second to notice a client that went away.
            await waker.wait(min(left, 1.0))
    finally:
        unsubscribe()
        remaining = active.get(member.id, 1) - 1
        if remaining <= 0:
            active.pop(member.id, None)
        else:
            active[member.id] = remaining


@router.post("/inbox/ack", status_code=204)
async def ack_inbox(body: AckInboxRequest, member: CurrentMember, pool: Pool):
    """Move the read cursor manually (after reading with ack=false). It never moves backwards."""
    async with pool.connection() as conn:
        await conn.execute(
            """update members
                  set inbox_cursor = greatest(
                        inbox_cursor,
                        least(%s, (select last_seq from boards where id = %s)))
                where id = %s""",
            (body.up_to, member.board_id, member.id),
        )
    return Response(status_code=204)
