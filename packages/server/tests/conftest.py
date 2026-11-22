"""Test setup: a throwaway database, a real uvicorn server on a free port, and an HTTP client.

Needs PostgreSQL: run `pnpm db:up` from the repository root (or set DATABASE_URL).
"""

import asyncio
import os
import secrets
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx
import psycopg
import pytest
import pytest_asyncio
import uvicorn

from hailboard_server.app import create_app
from hailboard_server.config import Config
from hailboard_server.db import create_pool, migrate

DEFAULT_URL = "postgres://hailboard:hailboard@localhost:5432/hailboard"
NO_BODY: Any = object()


def _with_database(url: str, name: str) -> str:
    parts = urlsplit(url)
    return urlunsplit(parts._replace(path=f"/{name}"))


@pytest.fixture(scope="session")
def database_url() -> Any:
    admin_url = os.environ.get("DATABASE_URL", DEFAULT_URL)
    name = f"hailboard_test_{secrets.token_hex(4)}"
    try:
        admin = psycopg.connect(admin_url, autocommit=True)
    except psycopg.OperationalError as error:
        pytest.exit(
            f'Cannot reach PostgreSQL at {urlsplit(admin_url).hostname}. Start it with "pnpm db:up". '
            f"({error})",
            returncode=2,
        )
    admin.execute(f"create database {name}")
    yield _with_database(admin_url, name)
    admin.execute(f"drop database if exists {name} with (force)")
    admin.close()


@dataclass
class Reply:
    status: int
    json: Any
    headers: httpx.Headers


class Api:
    """HTTP client for the test server, plus direct database access for assertions."""

    def __init__(self, client: httpx.AsyncClient, pool: Any, app: Any):
        self.client = client
        self.pool = pool
        self.app = app

    async def call(self, method: str, path: str, *, key: str | None = None, body: Any = NO_BODY):
        headers = {"authorization": f"Bearer {key}"} if key else {}
        response = await self.client.request(
            method, path, headers=headers, json=None if body is NO_BODY else body
        )
        data = response.json() if response.content else None
        return Reply(response.status_code, data, response.headers)

    async def sql(self, query: str, params: tuple = ()) -> list[dict]:
        async with self.pool.connection() as conn:
            cur = await conn.execute(query, params or None)
            return await cur.fetchall() if cur.description else []


@pytest_asyncio.fixture(scope="session")
async def api(database_url: str) -> AsyncIterator[Api]:
    pool = create_pool(database_url)
    await pool.open()
    await migrate(pool)

    config = Config(database_url=database_url, public_url="http://test.local")
    app = create_app(config)
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host="127.0.0.1",
            port=0,
            log_level="warning",
            lifespan="on",
            # The default 5 seconds races the client's connection pool: a request sent on a
            # kept-alive connection just as the server closes it fails with ReadError.
            timeout_keep_alive=300,
        )
    )
    task = asyncio.create_task(server.serve())
    while not server.started:
        if task.done():
            task.result()
        await asyncio.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]

    async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", timeout=20) as client:
        yield Api(client, pool, app)

    server.should_exit = True
    await task
    await pool.close()


@dataclass
class Team:
    board_id: str
    join_token: str
    read_token: str
    alice: str  # human alice
    claude: str  # agent alice/claude
    bob: str  # human bob
    codex: str  # agent bob/codex


async def new_team(api: Api, name: str = "team", *, keep_join_events: bool = False) -> Team:
    """A fresh board with alice (human) + alice/claude (agent) and bob (human) + bob/codex.

    Joining posts two activity events. Most tests count messages from 1, so the events are
    removed and the numbering restarts, unless `keep_join_events` is set.
    """
    board = await api.call("POST", "/v1/boards", body={"name": name})
    join_token = board.json["join_token"]
    # Bob joins with the same invite as alice; most tests are not about approval.
    await api.sql(
        "update board_tokens set requires_approval = false where board_id = %s",
        (board.json["board"]["id"],),
    )

    async def join(owner: str, agent: str) -> tuple[str, str]:
        res = await api.call(
            "POST",
            "/v1/boards/join",
            body={
                "join_token": join_token,
                "owner": owner,
                "members": [
                    {"handle": owner, "kind": "human"},
                    {"handle": f"{owner}/{agent}", "kind": "agent"},
                ],
            },
        )
        assert res.status == 201, res.json
        keys = {m["handle"]: m["api_key"] for m in res.json["members"]}
        return keys[owner], keys[f"{owner}/{agent}"]

    alice, claude = await join("alice", "claude")
    bob, codex = await join("bob", "codex")
    board_id = board.json["board"]["id"]
    if not keep_join_events:
        await api.sql("delete from messages where board_id = %s and kind = 'activity'", (board_id,))
        await api.sql("update boards set last_seq = 0 where id = %s", (board_id,))
    return Team(
        board.json["board"]["id"],
        join_token,
        board.json["read_token"],
        alice,
        claude,
        bob,
        codex,
    )
