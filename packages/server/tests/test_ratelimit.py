"""Rate limiting: the limiter itself, and the limits as seen over HTTP."""

import asyncio
from collections.abc import AsyncIterator

import httpx
import pytest
import pytest_asyncio
import uvicorn

from hailboard_server.app import create_app
from hailboard_server.config import Config
from hailboard_server.ratelimit import Limit, RateLimiter

LIMIT = Limit("test", 3, 60)


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_allows_up_to_the_limit_then_blocks():
    limiter = RateLimiter(clock=Clock())
    for _ in range(3):
        limiter.check(LIMIT, "ip", "things")
    with pytest.raises(Exception) as caught:
        limiter.check(LIMIT, "ip", "things")
    error = caught.value
    assert error.code == "rate_limited"
    assert error.headers == {"Retry-After": "60"}


def test_keys_are_independent():
    limiter = RateLimiter(clock=Clock())
    for _ in range(3):
        limiter.check(LIMIT, "a", "things")
    limiter.check(LIMIT, "b", "things")


def test_window_slides():
    clock = Clock()
    limiter = RateLimiter(clock=clock)
    for _ in range(3):
        limiter.check(LIMIT, "ip", "things")
        clock.now += 10
    assert limiter.retry_after(LIMIT, "ip") == 30  # the oldest hit leaves the window at +60
    clock.now += 30
    limiter.check(LIMIT, "ip", "things")


def test_disabled_limiter_never_blocks():
    limiter = RateLimiter(enabled=False)
    for _ in range(100):
        limiter.check(LIMIT, "ip", "things")


@pytest_asyncio.fixture
async def limited(database_url: str) -> AsyncIterator[httpx.AsyncClient]:
    config = Config(
        database_url=database_url,
        public_url="http://test.local",
        auto_migrate=True,
        rate_limits=True,
        trust_proxy=True,
    )
    server = uvicorn.Server(
        uvicorn.Config(
            create_app(config), host="127.0.0.1", port=0, log_level="warning", lifespan="on"
        )
    )
    task = asyncio.create_task(server.serve())
    while not server.started:
        if task.done():
            task.result()
        await asyncio.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]
    async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", timeout=20) as client:
        yield client
    server.should_exit = True
    await task


async def test_board_creation_is_limited_per_address(limited: httpx.AsyncClient):
    def create(ip: str):
        return limited.post("/v1/boards", json={"name": "t"}, headers={"x-forwarded-for": ip})

    for _ in range(10):
        assert (await create("203.0.113.1")).status_code == 201

    blocked = await create("203.0.113.1")
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "rate_limited"
    assert int(blocked.headers["retry-after"]) > 0

    # Another address is unaffected.
    assert (await create("203.0.113.2")).status_code == 201


async def test_only_the_proxy_appended_address_counts(limited: httpx.AsyncClient):
    # A caller cannot dodge the limit by sending its own X-Forwarded-For: the proxy appends the
    # real address last, and that is the one used.
    for i in range(10):
        response = await limited.post(
            "/v1/boards",
            json={"name": "t"},
            headers={"x-forwarded-for": f"10.0.0.{i}, 198.51.100.7"},
        )
        assert response.status_code == 201
    response = await limited.post(
        "/v1/boards", json={"name": "t"}, headers={"x-forwarded-for": "10.9.9.9, 198.51.100.7"}
    )
    assert response.status_code == 429


async def test_repeated_bad_credentials_are_blocked(limited: httpx.AsyncClient):
    headers = {"x-forwarded-for": "203.0.113.50", "authorization": "Bearer ak_wrong"}
    for _ in range(20):
        assert (await limited.get("/v1/me", headers=headers)).status_code == 401
    blocked = await limited.get("/v1/me", headers=headers)
    assert blocked.status_code == 429


async def test_a_stopped_key_does_not_lock_out_the_address(limited: httpx.AsyncClient):
    ip = {"x-forwarded-for": "203.0.113.70"}
    board = (await limited.post("/v1/boards", json={"name": "t"}, headers=ip)).json()
    joined = await limited.post(
        "/v1/boards/join",
        json={
            "join_token": board["join_token"],
            "owner": "alice",
            "members": [
                {"handle": "alice", "kind": "human"},
                {"handle": "alice/claude", "kind": "agent"},
            ],
        },
        headers=ip,
    )
    alice, agent = (m["api_key"] for m in joined.json()["members"])
    as_alice = {**ip, "authorization": f"Bearer {alice}"}
    assert (await limited.delete("/v1/members/alice/claude", headers=as_alice)).status_code == 204
    # The agent's hooks keep calling with the stopped key, far more than the failure limit.
    for _ in range(30):
        res = await limited.get("/v1/me", headers={**ip, "authorization": f"Bearer {agent}"})
        assert res.json()["error"]["code"] == "removed"
    assert (await limited.get("/v1/me", headers=as_alice)).status_code == 200


async def test_files_are_limited_per_member(limited: httpx.AsyncClient):
    ip = {"x-forwarded-for": "203.0.113.90"}
    board = (await limited.post("/v1/boards", json={"name": "t"}, headers=ip)).json()
    keys: dict[str, str] = {}
    token = board["join_token"]
    for owner in ("alice", "bob"):
        joined = await limited.post(
            "/v1/boards/join",
            json={
                "join_token": token,
                "owner": owner,
                "members": [
                    {"handle": owner, "kind": "human"},
                    {"handle": f"{owner}/claude", "kind": "agent"},
                ],
            },
            headers=ip,
        )
        human, agent = joined.json()["members"]
        keys[owner] = agent["api_key"]
        if owner == "alice":
            # Bob comes in through an invite of alice's that needs no approval.
            made = await limited.post(
                "/v1/tokens",
                json={"scope": "join", "open": True},
                headers={**ip, "authorization": f"Bearer {human['api_key']}"},
            )
            token = made.json()["token"]

    def send(sender: str, to: str):
        return limited.post(
            "/v1/files",
            params={"name": "a.txt", "to": f"{to}/claude"},
            content=b"x",
            headers={**ip, "authorization": f"Bearer {keys[sender]}"},
        )

    for _ in range(30):
        assert (await send("alice", "bob")).status_code == 201
    blocked = await send("alice", "bob")
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "rate_limited"
    # Another member is unaffected.
    assert (await send("bob", "alice")).status_code == 201
