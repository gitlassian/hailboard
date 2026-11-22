import re
from dataclasses import dataclass
from typing import Annotated, Literal

from fastapi import Depends, Header, Request
from psycopg_pool import AsyncConnectionPool

from .credentials import hash_secret
from .errors import key_stopped, pending, removed, unauthorized
from .ratelimit import AUTH_FAILURES_PER_IP, client_ip, limiter, too_many


@dataclass(frozen=True)
class AuthMember:
    id: str
    board_id: str
    handle: str
    kind: Literal["human", "agent"]
    owner: str
    # "owner" for the person who owns the board, "member" for everyone else and every agent.
    role: Literal["owner", "member"] = "member"
    state: Literal["pending", "active"] = "active"
    # The key the request came with, and the machine it lives on (None: the person's first one).
    key_id: str = ""
    device: str | None = None

    @property
    def is_board_owner(self) -> bool:
        return self.kind == "human" and self.role == "owner"


def get_pool(request: Request) -> AsyncConnectionPool:
    return request.app.state.pool


Pool = Annotated[AsyncConnectionPool, Depends(get_pool)]


async def current_member(
    request: Request,
    pool: Pool,
    authorization: Annotated[str | None, Header()] = None,
) -> AuthMember:
    """Authenticates `Authorization: Bearer <api_key>` of a member who is on the board."""
    member = await _authenticate(request, pool, authorization)
    if member.state == "pending":
        async with pool.connection() as conn:
            cur = await conn.execute(
                "select handle from members where board_id = %s and role = 'owner'",
                (member.board_id,),
            )
            row = await cur.fetchone()
        owner = row["handle"] if row else "the board's owner"
        raise pending(f"{owner} has not let you onto this board yet")
    return member


async def member_or_pending(
    request: Request,
    pool: Pool,
    authorization: Annotated[str | None, Header()] = None,
) -> AuthMember:
    """Like `current_member`, but also a member who still waits to be let in (for GET /me)."""
    return await _authenticate(request, pool, authorization)


async def _authenticate(
    request: Request, pool: AsyncConnectionPool, authorization: str | None
) -> AuthMember:
    ip = client_ip(request)
    limits = limiter(request)
    blocked = limits.retry_after(AUTH_FAILURES_PER_IP, ip)
    if blocked:
        raise too_many("failed authentication attempts from this address", blocked)

    match = re.fullmatch(r"Bearer\s+(\S+)", authorization or "", re.IGNORECASE)
    if not match:
        limits.hit(AUTH_FAILURES_PER_IP, ip)
        raise unauthorized()

    async with pool.connection() as conn:
        cur = await conn.execute(
            """select m.id, m.board_id, m.handle, m.kind, m.owner, m.state, m.role,
                      k.id as key_id, k.device
                 from api_keys k
                 join members m on m.id = k.member_id
                where k.key_hash = %s
                  and k.revoked_at is null
                  and m.state in ('active', 'pending')""",
            (hash_secret(match.group(1)),),
        )
        row = await cur.fetchone()
        if row is None:
            # A key that was real and was stopped (its member left or was taken off) is not a
            # guess: it is not counted, so the hooks of someone taken off cannot lock out
            # everyone else behind the same address.
            cur = await conn.execute(
                """select m.state from api_keys k join members m on m.id = k.member_id
                    where k.key_hash = %s""",
                (hash_secret(match.group(1)),),
            )
            stopped = await cur.fetchone()
            if stopped is not None:
                if stopped["state"] in ("active", "pending"):
                    # The member is still on the board; only this key was stopped.
                    raise key_stopped()
                raise removed()
            limits.hit(AUTH_FAILURES_PER_IP, ip)
            raise unauthorized()

        # Presence: touch last_seen_at / last_used_at at most every 30 seconds. Waiting for
        # messages keeps a member reachable but is not work, so it leaves last_active_at alone.
        await conn.execute(
            """update members set last_seen_at = now()
                where id = %s
                  and (last_seen_at is null or last_seen_at < now() - interval '30 seconds')""",
            (row["id"],),
        )
        if not request.url.path.endswith("/inbox/wait"):
            await conn.execute(
                """update members set last_active_at = now()
                    where id = %s
                      and (last_active_at is null
                           or last_active_at < now() - interval '30 seconds')""",
                (row["id"],),
            )
        await conn.execute(
            """update api_keys set last_used_at = now()
                where id = %s
                  and (last_used_at is null or last_used_at < now() - interval '30 seconds')""",
            (row["key_id"],),
        )

    return AuthMember(
        row["id"],
        row["board_id"],
        row["handle"],
        row["kind"],
        row["owner"],
        "owner" if row["kind"] == "human" and row["role"] == "owner" else "member",
        row["state"],
        row["key_id"],
        row["device"],
    )


CurrentMember = Annotated[AuthMember, Depends(current_member)]
MemberOrPending = Annotated[AuthMember, Depends(member_or_pending)]
