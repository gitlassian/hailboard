import hashlib
from datetime import timedelta
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Path, Query, Request, Response

from ..auth import CurrentMember, Pool
from ..errors import forbidden, gone, invalid, not_found, too_large
from ..files import clean_name, get_file, list_files, public
from ..handles import parse_handle
from ..mentions import parse_mentions
from ..posting import post
from ..ratelimit import FILES_PER_MEMBER, limiter
from ..schemas import (
    FILE_DAYS,
    MAX_BOARD_FILE_BYTES,
    MAX_FILE_BYTES,
    MAX_FILE_NAME_LENGTH,
    MAX_FILE_NOTE_LENGTH,
    MAX_FILE_RECIPIENTS,
    MAX_PAGE_SIZE,
    FileInfo,
    FileSent,
    FilesResponse,
)
from ..text import has_control

router = APIRouter()

Number = Annotated[int, Path(ge=1)]


async def _body(request: Request, limit: int) -> bytes:
    """The request body, refused as soon as it is known to be over the limit."""
    over = too_large(f"a file can be at most {limit // (1024 * 1024)} MB")
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        raise over
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise over
        chunks.append(chunk)
    return b"".join(chunks)


@router.post(
    "/files",
    status_code=201,
    response_model=FileSent,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/octet-stream": {"schema": {"type": "string", "format": "binary"}}
            },
        }
    },
)
async def send(
    request: Request,
    member: CurrentMember,
    pool: Pool,
    name: Annotated[str, Query(min_length=1, max_length=MAX_FILE_NAME_LENGTH)],
    to: Annotated[list[str], Query(min_length=1, max_length=MAX_FILE_RECIPIENTS)],
    reply_to: Annotated[int | None, Query(ge=1)] = None,
    note: Annotated[str | None, Query(max_length=MAX_FILE_NOTE_LENGTH)] = None,
):
    """Send a file to members of the board. The request body is the content of the file.

    The file travels with a message addressed to `to`, so it reaches their inboxes like any
    message. Only they, the sender, and members with the same owner can download it.
    """
    limiter(request).check(FILES_PER_MEMBER, member.id, "files from this member")
    stored_name = clean_name(name)
    handles = list(dict.fromkeys(h.strip().lstrip("@").lower() for h in to))
    not_handles = [h for h in handles if parse_handle(h) is None]
    if not_handles:
        raise invalid(f"to: not a member's handle: {', '.join(repr(h) for h in not_handles)}")
    if member.handle in handles:
        raise invalid("to: you cannot send a file to yourself")
    said = note.strip() if note else ""
    if has_control(said):
        raise invalid("note: one line of plain text is needed")
    named = parse_mentions(said)
    if named.all or named.humans:
        raise invalid("note: @all and @human would send the file to everyone: leave them out")
    # The name is not part of the text: a name like "@all.txt" would address the message.
    text = " ".join(f"@{h}" for h in handles) + " " + (said or "a file for you")
    content = await _body(request, MAX_FILE_BYTES)
    if not content:
        raise invalid("the file is empty")
    total_limit = request.app.state.config.files_total_bytes

    async with pool.connection() as conn, conn.transaction():
        cur = await conn.execute(
            """select handle, owner from members
                where board_id = %s and state = 'active' and handle = any(%s)""",
            (member.board_id, handles),
        )
        owners = {r["handle"]: r["owner"] for r in await cur.fetchall()}
        missing = [h for h in handles if h not in owners]
        if missing:
            raise invalid(f"to: not on this board: {', '.join(missing)}")

        # One sender at a time per board, so two uploads cannot pass the limit together.
        cur = await conn.execute(
            """update boards set last_file_number = last_file_number + 1
                where id = %s returning last_file_number""",
            (member.board_id,),
        )
        counter = await cur.fetchone()
        assert counter is not None
        cur = await conn.execute(
            """select coalesce(sum(size) filter (where board_id = %s), 0)::bigint as board,
                      coalesce(sum(size), 0)::bigint as server
                 from files
                where content is not null and expires_at > now()""",
            (member.board_id,),
        )
        held = await cur.fetchone()
        assert held is not None
        if held["board"] + len(content) > MAX_BOARD_FILE_BYTES:
            raise too_large(
                f"the board holds {MAX_BOARD_FILE_BYTES // (1024 * 1024)} MB of files already: "
                "take some back, or wait until they expire"
            )
        # Boards are free to create, so the boards together have a limit as well.
        if held["server"] + len(content) > total_limit:
            raise too_large("the server holds as many files as it has room for: try again later")

        message, _ = await post(conn, member, body=text, kind="message", reply_to=reply_to)
        # A mention in the note and a reply address the message to more members, and whoever
        # gets the message can get the file. That is fine for members who could get it anyway
        # (those of the same person as the sender or a recipient) and refused for anyone else.
        extra = sorted(set(message["recipients"]) - set(handles))
        if extra:
            cur = await conn.execute(
                "select handle, owner from members where board_id = %s and handle = any(%s)",
                (member.board_id, extra),
            )
            allowed = {member.owner, *owners.values()}
            outsiders = sorted(
                r["handle"] for r in await cur.fetchall() if r["owner"] not in allowed
            )
            if outsiders:
                raise invalid(
                    f"the file would also reach {', '.join(outsiders)}: name them in `to`, or "
                    "leave out the mention or the reply that brings them in"
                )
        await conn.execute(
            """insert into files
                 (board_id, number, name, size, sha256, content, uploaded_by, seq, expires_at)
               values (%s, %s, %s, %s, %s, %s, %s, %s, now() + %s)""",
            (
                member.board_id,
                counter["last_file_number"],
                stored_name,
                len(content),
                hashlib.sha256(content).digest(),
                content,
                member.id,
                message["seq"],
                timedelta(days=FILE_DAYS),
            ),
        )
        file = await get_file(conn, member, counter["last_file_number"])
        assert file is not None

    info = public(file)
    ref = {k: info[k] for k in ("number", "name", "size", "expires_at", "available")}
    return {"file": info, "message": {**message, "files": [ref]}}


@router.get("/files", response_model=FilesResponse)
async def files(
    member: CurrentMember,
    pool: Pool,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = MAX_PAGE_SIZE,
):
    """The files sent to me or by me (or by and to members with my owner), newest first."""
    async with pool.connection() as conn:
        return {"files": [public(f) for f in await list_files(conn, member, limit)]}


@router.get("/files/{number}", response_model=FileInfo)
async def info(number: Number, member: CurrentMember, pool: Pool):
    """What is known about one file."""
    async with pool.connection() as conn:
        return public(await _mine(conn, member, number))


@router.get(
    "/files/{number}/content",
    response_class=Response,
    responses={200: {"content": {"application/octet-stream": {}}}},
)
async def content(number: Number, member: CurrentMember, pool: Pool):
    """The content of a file, for its sender and its recipients."""
    async with pool.connection() as conn:
        file = await _mine(conn, member, number)
        if not file["available"]:
            raise gone(f"file #{number} is no longer kept: its time is up or it was taken back")
        cur = await conn.execute("select content from files where id = %s", (file["id"],))
        row = await cur.fetchone()
    if row is None or row["content"] is None:
        raise gone(f"file #{number} is no longer kept")
    return Response(
        content=bytes(row["content"]),
        media_type="application/octet-stream",
        headers={
            # Never shown by a browser as a page, whatever is inside.
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(file['name'])}",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
            "X-File-Sha256": file["sha256"],
        },
    )


@router.delete("/files/{number}", status_code=204)
async def remove(number: Number, member: CurrentMember, pool: Pool):
    """Take a file back before its time is up. Only its sender (or the sender's owner) can."""
    async with pool.connection() as conn, conn.transaction():
        file = await get_file(conn, member, number)
        if file is None:
            raise not_found(f"no file #{number}")
        if file["from_owner"] != member.owner:
            raise forbidden(f"only {file['from']} can take this file back")
        await conn.execute(
            "update files set content = null, removed_at = now() where id = %s", (file["id"],)
        )
    return Response(status_code=204)


async def _mine(conn, member, number: int):
    file = await get_file(conn, member, number)
    if file is None:
        raise not_found(f"no file #{number}")
    if not file["mine"]:
        raise forbidden(f"file #{number} was not sent to you")
    return file
