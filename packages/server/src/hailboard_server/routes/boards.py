from datetime import UTC, datetime, timedelta
from typing import Annotated

import psycopg.errors
from fastapi import APIRouter, Query, Request, Response

from ..auth import CurrentMember, Pool
from ..credentials import generate_secret, hash_secret
from ..errors import conflict, forbidden, invalid, not_found, unauthorized
from ..joins import INITIAL_INVITE_LABEL, Invite, join_text, post_activity, request_text
from ..membership import board_owner, lock_owner, notify, person_and_agents, person_rows, record
from ..ratelimit import (
    BOARDS_PER_IP,
    INVITE_LOOKUPS_PER_IP,
    JOINS_PER_IP,
    client_ip,
    limiter,
)
from ..schemas import (
    DEFAULT_INVITE_DAYS,
    BoardCreated,
    CreateBoardRequest,
    CreateTokenRequest,
    InviteInfo,
    JoinBoardRequest,
    JoinResult,
    TokenCreated,
    TokensResponse,
)

# An invite that still lets people in: not revoked, not expired, not used up.
_USABLE = """t.revoked_at is null
             and (t.expires_at is null or t.expires_at > now())
             and (t.max_uses is null or t.uses < t.max_uses)"""

router = APIRouter()


@router.post("/boards", status_code=201, response_model=BoardCreated)
async def create_board(body: CreateBoardRequest, request: Request, pool: Pool):
    """Create a board. Open to anyone; the tokens in the response are shown only once."""
    config = request.app.state.config
    limiter(request).check(BOARDS_PER_IP, client_ip(request), "boards created from this address")
    join_token = generate_secret("join_token")
    read_token = generate_secret("read_token")

    async with pool.connection() as conn, conn.transaction():
        cur = await conn.execute("insert into boards (name) values (%s) returning id", (body.name,))
        row = await cur.fetchone()
        assert row is not None
        board_id = row["id"]
        # The first invite ends like any other; whoever joins first with it becomes the owner
        # and the maker of both links (see join_board).
        await conn.execute(
            """insert into board_tokens
                 (board_id, scope, token_hash, label, expires_at, requires_approval)
               values (%s, 'join', %s, %s, now() + make_interval(days => %s), true),
                      (%s, 'read', %s, 'initial feed', null, false)""",
            (
                board_id,
                hash_secret(join_token),
                INITIAL_INVITE_LABEL,
                DEFAULT_INVITE_DAYS,
                board_id,
                hash_secret(read_token),
            ),
        )

    return {
        "board": {"id": board_id, "name": body.name},
        "join_token": join_token,
        "read_token": read_token,
        "join_url": f"{config.public_url}/join/{join_token}",
        "feed_url": f"{config.public_url}/feed/{read_token}",
    }


@router.get("/invite", response_model=InviteInfo)
async def invite_info(
    request: Request, pool: Pool, token: Annotated[str, Query(min_length=1, max_length=200)]
):
    """The board an invite link leads to, so the join page can name it. Answers 401 for a token
    that is unknown, expired or revoked. Using the invite still needs POST /boards/join."""
    limiter(request).check(INVITE_LOOKUPS_PER_IP, client_ip(request), "invite lookups")
    async with pool.connection() as conn:
        cur = await conn.execute(
            f"""select t.board_id, b.name, t.label, t.expires_at, t.requires_approval
                 from board_tokens t
                 join boards b on b.id = t.board_id
                where t.token_hash = %s
                  and t.scope = 'join'
                  and {_USABLE}""",
            (hash_secret(token),),
        )
        row = await cur.fetchone()
    if row is None:
        raise unauthorized("invalid, expired or revoked join token")
    label = row["label"] if row["label"] not in (None, INITIAL_INVITE_LABEL) else None
    return {
        "board": {"id": row["board_id"], "name": row["name"]},
        "label": label,
        "expires_at": row["expires_at"],
        "requires_approval": row["requires_approval"],
    }


@router.post("/boards/join", status_code=201, response_model=JoinResult)
async def join_board(body: JoinBoardRequest, request: Request, pool: Pool):
    """Join a board with a join token and register members (a human and/or agents).

    The first person on a board created it and owns it. Anyone else who comes through an invite
    that needs approval waits: their keys work only for GET /me until the owner lets them in, and
    the owner and the owner's agents are told. A name that was ever on the board stays taken, also
    after its person left or was taken off: whoever comes back joins under a new name, so nobody
    can pick up someone else's messages or files by taking their old name.
    """
    limiter(request).check(JOINS_PER_IP, client_ip(request), "join attempts from this address")
    async with pool.connection() as conn:
        cur = await conn.execute(
            f"""select t.id, t.board_id, b.name, t.label, t.requires_approval,
                       issuer.handle as issued_by
                  from board_tokens t
                  join boards b on b.id = t.board_id
                  left join members issuer on issuer.id = t.created_by
                 where t.token_hash = %s
                   and t.scope = 'join'
                   and {_USABLE}""",
            (hash_secret(body.join_token),),
        )
        token = await cur.fetchone()
    if token is None:
        raise unauthorized("invalid, expired, used up or revoked join token")
    board_id = token["board_id"]

    members: list[dict] = []
    try:
        async with pool.connection() as conn, conn.transaction():
            # Lock the board so two first joins at once cannot both claim to have created it.
            await conn.execute("select 1 from boards where id = %s for update", (board_id,))
            cur = await conn.execute(
                "select exists (select 1 from members where board_id = %s) as taken", (board_id,)
            )
            row = await cur.fetchone()
            created_board = not (row and row["taken"])

            # Count the use, unless the link was stopped or its last use went to somebody else
            # in the meantime.
            cur = await conn.execute(
                f"""update board_tokens t set uses = uses + 1
                     where t.id = %s and {_USABLE} returning t.id""",
                (token["id"],),
            )
            if await cur.fetchone() is None:
                raise unauthorized("invalid, expired, used up or revoked join token")

            # An invite brings in new people. A name that is, or ever was, on the board belongs to
            # that person: more agents of theirs are added with their own key (POST /agents), so
            # nobody with the invite can become "alice/other", or come back as "alice" after
            # she left, and act or read files as alice.
            if await person_rows(conn, board_id, body.owner):
                raise conflict(f'"{body.owner}" is already on this board')

            human = next((m for m in body.members if m.kind == "human"), None)
            owner = await board_owner(conn, board_id)
            if created_board:
                if human is None:
                    raise invalid("members: the first member of a new board is a person")
                state = "active"
            elif owner is None:
                raise forbidden("this board has no owner, so nobody can let you onto it")
            elif token["requires_approval"]:
                state = "pending"
            else:
                state = "active"

            for member in body.members:
                api_key = generate_secret("api_key")
                role = "owner" if created_board and member.kind == "human" else "member"
                cur = await conn.execute(
                    """insert into members
                         (board_id, handle, kind, owner, role, state, state_at, joined_with,
                          timezone)
                       values (%s, %s, %s, %s, %s, %s, now(), %s, %s) returning id""",
                    (
                        board_id,
                        member.handle,
                        member.kind,
                        body.owner,
                        role,
                        state,
                        token["id"],
                        body.timezone if member.kind == "human" else None,
                    ),
                )
                row = await cur.fetchone()
                assert row is not None
                member_id = row["id"]
                if role == "owner":
                    # The board's first links were made before anyone was on it: they are the
                    # creator's, and stop with the creator like any other link.
                    await conn.execute(
                        """update board_tokens set created_by = %s
                            where board_id = %s and created_by is null""",
                        (member_id, board_id),
                    )
                await conn.execute(
                    "insert into api_keys (member_id, key_hash) values (%s, %s)",
                    (member_id, hash_secret(api_key)),
                )
                members.append(
                    {
                        "id": member_id,
                        "handle": member.handle,
                        "kind": member.kind,
                        "api_key": api_key,
                    }
                )

            author = next((m for m in members if m["kind"] == "human"), members[0])
            agents = [m["handle"] for m in members if m["kind"] == "agent"]
            invite = Invite(token["label"], token["issued_by"])
            owner = owner or await board_owner(conn, board_id)
            owner_handle = owner["handle"] if owner else body.owner
            if state == "pending" and owner is not None:
                told = await person_and_agents(conn, board_id, owner_handle)
                text = request_text(
                    body.owner,
                    agents,
                    invite=invite,
                    board_owner=owner_handle,
                    wanted_owner=body.wanted_owner,
                )
                await notify(conn, board_id, author["id"], text, told)
                await record(
                    conn,
                    board_id,
                    "member_requested",
                    actor=body.owner,
                    subject=body.owner,
                    data={"link": token["id"], "agents": agents},
                )
            else:
                text = join_text(
                    body.owner,
                    agents,
                    created_board=created_board,
                    invite=invite,
                    wanted_owner=body.wanted_owner,
                )
                await post_activity(conn, board_id, author["id"], text)
                await record(
                    conn,
                    board_id,
                    "board_created" if created_board else "member_joined",
                    actor=body.owner,
                    subject=body.owner,
                    data={"link": token["id"], "agents": agents},
                )
    except psycopg.errors.UniqueViolation:
        raise conflict("a member with that handle already exists on this board") from None

    return {
        "board": {"id": board_id, "name": token["name"]},
        "members": members,
        "state": state,
        "board_owner": owner_handle,
    }


@router.post("/tokens", status_code=201, response_model=TokenCreated)
async def create_token(
    body: CreateTokenRequest, request: Request, member: CurrentMember, pool: Pool
):
    """Issue another join or read token (for example a new invite link).

    An invite works for a week unless `expires_in_hours` says otherwise, and needs the owner's
    approval for each newcomer unless it is `open`, which only the owner can make.
    """
    config = request.app.state.config
    join = body.scope == "join"
    open_invite = "make an invite that needs no approval"
    if join and body.open and not member.is_board_owner:
        raise forbidden(f"only the board's owner can {open_invite}")
    secret = generate_secret("join_token" if join else "read_token")
    hours = body.expires_in_hours
    if hours is None and join:
        hours = DEFAULT_INVITE_DAYS * 24
    expires_at = None if hours is None else datetime.now(UTC) + timedelta(hours=hours)
    requires_approval = join and not body.open
    max_uses = body.max_uses if join else None

    async with pool.connection() as conn, conn.transaction():
        if join and body.open:
            await lock_owner(conn, member.id, open_invite)
        cur = await conn.execute(
            """insert into board_tokens
                 (board_id, scope, token_hash, label, expires_at, created_by,
                  requires_approval, max_uses)
               values (%s, %s, %s, %s, %s, %s, %s, %s) returning id""",
            (
                member.board_id,
                body.scope,
                hash_secret(secret),
                body.label,
                expires_at,
                member.id,
                requires_approval,
                max_uses,
            ),
        )
        row = await cur.fetchone()
        assert row is not None
        await record(
            conn,
            member.board_id,
            "link_created",
            actor=member.handle,
            subject=row["id"],
            data={"scope": body.scope, "open": body.open, "max_uses": max_uses},
        )

    path = "join" if join else "feed"
    return {
        "id": row["id"],
        "scope": body.scope,
        "token": secret,
        "url": f"{config.public_url}/{path}/{secret}",
        "expires_at": expires_at,
        "requires_approval": requires_approval,
        "max_uses": max_uses,
    }


@router.get("/tokens", response_model=TokensResponse)
async def list_tokens(member: CurrentMember, pool: Pool):
    """The board's invite and feed links, without their secrets. The owner sees every link;
    anyone else the links they or their agents made."""
    async with pool.connection() as conn:
        cur = await conn.execute(
            f"""select t.id, t.scope, t.label, c.handle as created_by, t.created_at, t.expires_at,
                       t.revoked_at, t.uses, t.max_uses, t.requires_approval,
                       ({_USABLE}) as active
                  from board_tokens t
                  left join members c on c.id = t.created_by
                 where t.board_id = %s and (%s or c.owner = %s)
                 order by t.created_at""",
            (member.board_id, member.is_board_owner, member.owner),
        )
        return {"tokens": await cur.fetchall()}


@router.delete("/tokens/{token_id}", status_code=204)
async def revoke_token(token_id: str, member: CurrentMember, pool: Pool):
    """Stop an invite or feed link. The owner can stop any; anyone else their own. A web panel
    open with a revoked feed link stops getting the board within half a minute. A person's own
    key only: an agent cannot stop links."""
    if member.kind != "human":
        raise forbidden("only a person can stop a link; use your own key, not an agent's")
    async with pool.connection() as conn, conn.transaction():
        cur = await conn.execute(
            """select t.id, t.revoked_at, c.owner as made_by
                 from board_tokens t
                 left join members c on c.id = t.created_by
                where t.id = %s and t.board_id = %s
                for update of t""",
            (token_id, member.board_id),
        )
        row = await cur.fetchone()
        if row is None:
            raise not_found(f"no link {token_id} on this board")
        if row["made_by"] != member.owner:
            await lock_owner(conn, member.id, "stop a link someone else made")
        if row["revoked_at"] is None:
            await conn.execute(
                "update board_tokens set revoked_at = now(), revoked_by = %s where id = %s",
                (member.handle, token_id),
            )
            await record(
                conn, member.board_id, "link_revoked", actor=member.handle, subject=token_id
            )
    return Response(status_code=204)
