"""One person on several machines.

A person makes a one-time code on a machine that is on the board (`POST /me/devices`). Another
machine redeems it (`POST /devices/redeem`) and gets keys of its own for the same person and each
of their agents, so the person does not join a second time and wait for the owner again. Each key
remembers its machine, so one machine can be taken off without the others.
"""

from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Query, Request, Response

from ..auth import CurrentMember, Pool
from ..credentials import generate_secret, hash_secret
from ..errors import forbidden, invalid, not_found, unauthorized
from ..membership import person_rows, record
from ..ratelimit import INVITE_LOOKUPS_PER_IP, JOINS_PER_IP, client_ip, limiter
from ..schemas import (
    DeviceCode,
    DeviceInfo,
    DeviceJoined,
    DevicesResponse,
    MakeDeviceCodeRequest,
    RedeemDeviceRequest,
)

router = APIRouter()

CODE_MINUTES = 10


def _person_only(member) -> None:
    if member.kind != "human":
        raise forbidden("only a person can manage their machines; use your own key, not an agent's")


async def _name_in_use(conn, board_id: str, person: str, device: str) -> bool:
    """Whether a working key of the person or their agents already lives on a machine so named."""
    cur = await conn.execute(
        """select 1 from api_keys k join members m on m.id = k.member_id
            where m.board_id = %s and m.owner = %s and k.revoked_at is null and k.device = %s
            limit 1""",
        (board_id, person, device),
    )
    return await cur.fetchone() is not None


@router.post("/me/devices", status_code=201, response_model=DeviceCode)
async def make_code(
    body: MakeDeviceCodeRequest, request: Request, member: CurrentMember, pool: Pool
):
    """A code that brings another machine of the calling person onto the board. Works once, for
    10 minutes, and only while the key that made it works.

    `device` names the machine the request comes from, when its keys have no name yet (the
    person's first machine), so that it can be told apart and removed later.
    """
    _person_only(member)
    limiter(request).check(JOINS_PER_IP, client_ip(request), "join attempts from this address")
    code = generate_secret("device_code")
    async with pool.connection() as conn, conn.transaction():
        await person_rows(conn, member.board_id, member.handle)
        if body.device is not None and member.device is None:
            if await _name_in_use(conn, member.board_id, member.handle, body.device):
                raise invalid(f'device: you already have a machine called "{body.device}"')
            await conn.execute(
                """update api_keys k set device = %s
                     from members m
                    where m.id = k.member_id and m.board_id = %s and m.owner = %s
                      and k.revoked_at is null and k.device is null""",
                (body.device, member.board_id, member.handle),
            )
        cur = await conn.execute(
            """insert into device_codes (board_id, member_id, key_id, code_hash, expires_at)
               values (%s, %s, %s, %s, now() + %s) returning expires_at""",
            (
                member.board_id,
                member.id,
                member.key_id,
                hash_secret(code),
                timedelta(minutes=CODE_MINUTES),
            ),
        )
        row = await cur.fetchone()
        assert row is not None
        await record(conn, member.board_id, "device_code", actor=member.handle)
    config = request.app.state.config
    return {
        "code": code,
        "url": f"{config.public_url}/device/{code}",
        "expires_at": row["expires_at"],
    }


_USABLE_CODE = """
      from device_codes c
      join members m on m.id = c.member_id
      join boards b on b.id = c.board_id
      join api_keys k on k.id = c.key_id
     where c.code_hash = %s and c.used_at is null and c.expires_at > now()
       and k.revoked_at is null and m.state = 'active'"""

_NOT_USABLE = "this code does not work: it was used, it ended, or it is wrong"


@router.get("/devices/info", response_model=DeviceInfo)
async def code_info(request: Request, pool: Pool, code: Annotated[str, Query(max_length=100)]):
    """Which board and person a code is for, without using it, so that a machine can check
    before it redeems. Holds no secrets."""
    limiter(request).check(INVITE_LOOKUPS_PER_IP, client_ip(request), "invite lookups")
    async with pool.connection() as conn:
        cur = await conn.execute(
            "select c.board_id, b.name as board_name, m.handle, c.expires_at" + _USABLE_CODE,
            (hash_secret(code),),
        )
        found = await cur.fetchone()
    if found is None:
        raise unauthorized(_NOT_USABLE)
    return {
        "board": {"id": found["board_id"], "name": found["board_name"]},
        "owner": found["handle"],
        "expires_at": found["expires_at"],
    }


@router.post("/devices/redeem", status_code=201, response_model=DeviceJoined)
async def redeem(body: RedeemDeviceRequest, request: Request, pool: Pool):
    """Keys for a new machine of the person who made the code: theirs and their agents'."""
    limiter(request).check(JOINS_PER_IP, client_ip(request), "join attempts from this address")
    device = body.device
    async with pool.connection() as conn, conn.transaction():
        cur = await conn.execute(
            "select c.id, c.board_id, m.handle, b.name as board_name"
            + _USABLE_CODE
            + " for update of c",
            (hash_secret(body.code),),
        )
        found = await cur.fetchone()
        if found is None:
            raise unauthorized(_NOT_USABLE)
        # Lock the person and their agents: a machine of the same name, or an agent taken off,
        # cannot slip in between the checks and the new keys.
        rows = [
            r
            for r in await person_rows(conn, found["board_id"], found["handle"])
            if r["state"] == "active"
        ]
        if not any(r["kind"] == "human" for r in rows):
            raise unauthorized(_NOT_USABLE)
        if await _name_in_use(conn, found["board_id"], found["handle"], device):
            raise invalid(f'device: you already have a machine called "{device}" on this board')
        await conn.execute(
            "update device_codes set used_at = now(), used_by = %s where id = %s",
            (device, found["id"]),
        )
        members = []
        for row in rows:
            api_key = generate_secret("api_key")
            await conn.execute(
                "insert into api_keys (member_id, key_hash, device) values (%s, %s, %s)",
                (row["id"], hash_secret(api_key), device),
            )
            members.append(
                {"id": row["id"], "handle": row["handle"], "kind": row["kind"], "api_key": api_key}
            )
        await record(conn, found["board_id"], "device_added", actor=found["handle"], subject=device)
    return {
        "board": {"id": found["board_id"], "name": found["board_name"]},
        "owner": found["handle"],
        "device": device,
        "members": members,
    }


@router.get("/me/devices", response_model=DevicesResponse)
async def list_devices(member: CurrentMember, pool: Pool):
    """The calling person's machines on the board, by the keys that still work."""
    _person_only(member)
    async with pool.connection() as conn:
        cur = await conn.execute(
            """select k.device as name, min(k.created_at) as created_at,
                      max(k.last_used_at) as last_used_at
                 from api_keys k join members m on m.id = k.member_id
                where m.board_id = %s and m.owner = %s
                  and k.revoked_at is null
                group by k.device
                order by min(k.created_at)""",
            (member.board_id, member.handle),
        )
        rows = await cur.fetchall()
    return {
        "devices": [
            {
                "name": row["name"],
                "created_at": row["created_at"],
                "last_used_at": row["last_used_at"],
                "current": row["name"] == member.device,
            }
            for row in rows
        ]
    }


@router.delete("/me/devices/{name}", status_code=204)
async def remove_device(name: str, member: CurrentMember, pool: Pool):
    """Stops every key of the person and their agents on one machine."""
    _person_only(member)
    if name == member.device:
        raise invalid("this is the machine you are on; remove it from another one, or leave")
    async with pool.connection() as conn, conn.transaction():
        await person_rows(conn, member.board_id, member.handle)
        # Codes made on that machine stop with its keys (see _USABLE_CODE).
        cur = await conn.execute(
            """update api_keys k set revoked_at = now()
                 from members m
                where m.id = k.member_id and m.board_id = %s and m.owner = %s
                  and k.revoked_at is null and k.device = %s
            returning k.id""",
            (member.board_id, member.handle, name),
        )
        if not await cur.fetchall():
            raise not_found(f'you have no machine called "{name}" on this board')
        await record(conn, member.board_id, "device_removed", actor=member.handle, subject=name)
    return Response(status_code=204)
