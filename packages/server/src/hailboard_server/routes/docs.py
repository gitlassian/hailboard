from typing import Annotated

from fastapi import APIRouter, Query, Request, Response

from ..auth import CurrentMember, Pool
from ..documents import check_name, get_document, list_documents
from ..errors import conflict, not_found
from ..joins import post_activity
from ..ratelimit import MESSAGES_PER_MEMBER, limiter
from ..schemas import Document, DocumentInfo, DocumentsResponse, WriteDocumentRequest

router = APIRouter()


@router.get("/docs", response_model=DocumentsResponse)
async def documents(member: CurrentMember, pool: Pool):
    """The board's shared documents (without their text), pinned ones first."""
    return {"documents": await list_documents(pool, member.board_id)}


@router.get("/docs/{name:path}", response_model=Document)
async def document(
    name: str,
    member: CurrentMember,
    pool: Pool,
    version: Annotated[int | None, Query(ge=1)] = None,
):
    """One document: the current version, or an earlier one with `?version=N`."""
    found = await get_document(pool, member.board_id, check_name(name), version)
    if found is None:
        raise not_found(f'no document "{name}"' + (f" version {version}" if version else ""))
    return found


@router.put("/docs/{name:path}", response_model=DocumentInfo)
async def write_document(
    name: str,
    body: WriteDocumentRequest,
    request: Request,
    response: Response,
    member: CurrentMember,
    pool: Pool,
):
    """Create or update a document, and optionally pin or unpin it as board context.

    Every change of the text is a new version. With `base_version` the write is refused (409)
    when someone else changed the document in the meantime. The change is announced on the board
    as an activity event, which is in the feed and the log but in no one's inbox.
    """
    check_name(name)
    limiter(request).check(MESSAGES_PER_MEMBER, member.id, "messages from this member")

    async with pool.connection() as conn, conn.transaction():
        cur = await conn.execute(
            """select version, body, pinned from documents
                where board_id = %s and name = %s for update""",
            (member.board_id, name),
        )
        current = await cur.fetchone()
        version = current["version"] if current else 0
        if body.base_version is not None and body.base_version != version:
            raise conflict(
                f'"{name}" is at version {version}, not {body.base_version}: someone changed it. '
                "Read it again and apply your change to the new version.",
            )
        pinned = body.pinned if body.pinned is not None else bool(current and current["pinned"])
        text_changed = current is None or current["body"] != body.body
        pin_changed = current is not None and pinned != current["pinned"]

        if text_changed:
            version += 1
            await conn.execute(
                """insert into documents (board_id, name, body, version, pinned, updated_by)
                   values (%s, %s, %s, %s, %s, %s)
                   on conflict (board_id, name) do update
                     set body = excluded.body, version = excluded.version,
                         pinned = excluded.pinned, updated_by = excluded.updated_by,
                         updated_at = now()""",
                (member.board_id, name, body.body, version, pinned, member.id),
            )
            await conn.execute(
                """insert into document_versions (board_id, name, version, body, author_id)
                   values (%s, %s, %s, %s, %s)""",
                (member.board_id, name, version, body.body, member.id),
            )
        elif pin_changed:
            await conn.execute(
                "update documents set pinned = %s where board_id = %s and name = %s",
                (pinned, member.board_id, name),
            )

        # Pinning is news when it changed, or when a new document is pinned right away.
        pin_news = pinned if pin_changed or (current is None and pinned) else None
        event = _event(
            member.handle,
            name,
            version,
            created=current is None,
            text_changed=text_changed,
            pinned=pin_news,
        )
        if event:
            await post_activity(conn, member.board_id, member.id, event)

    response.status_code = 201 if current is None else 200
    found = await get_document(pool, member.board_id, name)
    assert found is not None
    return found


@router.delete("/docs/{name:path}", status_code=204)
async def delete_document(name: str, request: Request, member: CurrentMember, pool: Pool):
    """Remove a document and all its versions. Announced on the board as an activity event."""
    check_name(name)
    limiter(request).check(MESSAGES_PER_MEMBER, member.id, "messages from this member")
    async with pool.connection() as conn, conn.transaction():
        cur = await conn.execute(
            "delete from documents where board_id = %s and name = %s returning name",
            (member.board_id, name),
        )
        if await cur.fetchone() is None:
            raise not_found(f'no document "{name}"')
        await post_activity(
            conn, member.board_id, member.id, f"{member.handle} removed the document {name}."
        )
    return Response(status_code=204)


def _event(
    who: str, name: str, version: int, *, created: bool, text_changed: bool, pinned: bool | None
) -> str | None:
    """The activity line for a write, or None when nothing changed."""
    parts: list[str] = []
    if created:
        parts.append(f"added the document {name}")
    elif text_changed:
        parts.append(f"updated the document {name} (version {version})")
    if pinned is True:
        parts.append("pinned it as board context" if parts else f"pinned {name} as board context")
    elif pinned is False:
        parts.append("unpinned it" if parts else f"unpinned {name}")
    return f"{who} {' and '.join(parts)}." if parts else None
