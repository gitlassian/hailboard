"""Runs the server on a throwaway database, for end-to-end tests of other clients (the CLI).

    uv run python scripts/serve_for_tests.py

Prints "READY <port>" once the server accepts requests. Stops, and drops the database, on
SIGTERM or SIGINT, or when the parent process goes away. Needs PostgreSQL (DATABASE_URL, or the
local development database from `pnpm db:up`).
"""

import asyncio
import contextlib
import os
import secrets
import signal
import socket
from urllib.parse import urlsplit, urlunsplit

import psycopg
import uvicorn

from hailboard_server.app import create_app
from hailboard_server.config import Config

DEFAULT_URL = "postgres://hailboard:hailboard@localhost:5432/hailboard"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def main() -> None:
    admin_url = os.environ.get("DATABASE_URL", DEFAULT_URL)
    name = f"hailboard_e2e_{secrets.token_hex(4)}"
    admin = await psycopg.AsyncConnection.connect(admin_url, autocommit=True)
    await admin.execute(f"create database {name}")
    database_url = urlunsplit(urlsplit(admin_url)._replace(path=f"/{name}"))

    port = free_port()
    config = Config(
        database_url=database_url,
        port=port,
        public_url=f"http://127.0.0.1:{port}",
        auto_migrate=True,
    )
    server = uvicorn.Server(
        uvicorn.Config(
            create_app(config), host="127.0.0.1", port=port, log_level="warning", lifespan="on"
        )
    )

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    async def watch_parent() -> None:
        parent = os.getppid()
        while os.getppid() == parent:  # noqa: ASYNC110 - there is no event for "parent exited"
            await asyncio.sleep(1)
        stop.set()

    watcher = asyncio.create_task(watch_parent())
    serving = asyncio.create_task(server.serve())
    try:
        while not server.started:
            if serving.done():
                serving.result()
            await asyncio.sleep(0.05)
        print(f"READY {port}", flush=True)
        await stop.wait()
    finally:
        server.should_exit = True
        with contextlib.suppress(Exception):
            await serving
        watcher.cancel()
        await admin.execute(f"drop database if exists {name} with (force)")
        await admin.close()


if __name__ == "__main__":
    asyncio.run(main())
