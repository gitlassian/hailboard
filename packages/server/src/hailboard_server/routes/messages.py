from typing import Annotated

from fastapi import APIRouter, Query, Request

from ..auth import CurrentMember, Pool
from ..posting import post
from ..queries import list_messages
from ..ratelimit import MESSAGES_PER_MEMBER, limiter
from ..schemas import (
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
    MessagesPage,
    PostMessageRequest,
    PostMessageResponse,
)

router = APIRouter()


@router.post("/messages", status_code=201, response_model=PostMessageResponse)
async def post_message(
    body: PostMessageRequest, request: Request, member: CurrentMember, pool: Pool
):
    """Post a message. @mentions in the text decide who gets it in their inbox."""
    limiter(request).check(MESSAGES_PER_MEMBER, member.id, "messages from this member")
    async with pool.connection() as conn, conn.transaction():
        message, unknown = await post(
            conn, member, body=body.body, kind=body.kind, reply_to=body.reply_to
        )
    return {"message": message, "unknown_mentions": unknown}


@router.get("/messages", response_model=MessagesPage)
async def history(
    member: CurrentMember,
    pool: Pool,
    after: Annotated[int | None, Query(ge=0)] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = DEFAULT_PAGE_SIZE,
):
    """Board history. Without `after`, the latest messages. Does not move any cursor."""
    return await list_messages(pool, member.board_id, after=after, limit=limit)
