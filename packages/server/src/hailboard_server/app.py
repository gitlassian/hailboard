import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.datastructures import MutableHeaders
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import VERSION
from .config import Config, load_config
from .db import create_pool, migrate
from .errors import ApiError
from .files import expire_files
from .pubsub import PubSub
from .ratelimit import RateLimiter
from .routes import boards, devices, docs, feed, files, inbox, members, messages, tasks, zones
from .web import mount_web

log = logging.getLogger("hailboard")


class VersionHeaderMiddleware:
    """Adds X-Hailboard-Version to every response. Pure ASGI so streaming is not buffered."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_header(message: Message) -> None:
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message)["X-Hailboard-Version"] = VERSION
            await send(message)

        await self.app(scope, receive, send_with_header)


def _error(status: int, code: str, message: str, headers: dict[str, str] | None = None):
    return JSONResponse(
        {"error": {"code": code, "message": message}}, status_code=status, headers=headers
    )


def _describe(errors: list[Any]) -> str:
    """One readable line for the first validation problem."""
    if not errors:
        return "invalid request"
    first = errors[0]
    loc = tuple(first.get("loc", ()))
    if first.get("type") == "json_invalid" or (first.get("type") == "missing" and loc == ("body",)):
        return "request body must be valid JSON"
    path = ".".join(str(p) for p in loc if p not in ("body", "query", "header", "path"))
    message = str(first.get("msg", "invalid request")).removeprefix("Value error, ")
    return f"{path}: {message}" if path else message


FILE_SWEEP_SECONDS = 3600


async def _sweep_files(pool) -> None:
    """Drops the content of expired files when the server starts and then every hour."""
    while True:
        try:
            dropped = await expire_files(pool)
            if dropped:
                log.info("dropped the content of %s expired files", dropped)
        except Exception:
            log.exception("could not drop expired files")
        await asyncio.sleep(FILE_SWEEP_SECONDS)


def create_app(config: Config | None = None) -> FastAPI:
    config = config or load_config()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        pool = create_pool(config.database_url)
        await pool.open()
        await pool.wait()
        if config.auto_migrate:
            for version in await migrate(pool):
                log.info("applied migration %s", version)
        pubsub = PubSub()
        await pubsub.start(config.database_url)

        app.state.pool = pool
        app.state.pubsub = pubsub
        sweeper = asyncio.create_task(_sweep_files(pool))
        yield
        sweeper.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await sweeper
        await pubsub.stop()
        await pool.close()

    app = FastAPI(
        title="hailboard",
        version=VERSION,
        description="A coordination layer that lets teammates' coding agents talk to each other.",
        lifespan=lifespan,
    )
    app.state.config = config
    app.state.active_waits = {}
    app.state.limiter = RateLimiter(enabled=config.rate_limits)
    app.add_middleware(VersionHeaderMiddleware)

    @app.get("/health", tags=["service"])
    async def health(request: Request):
        try:
            async with request.app.state.pool.connection() as conn:
                await conn.execute("select 1")
        except Exception:
            return JSONResponse({"ok": False, "db": False}, status_code=503)
        return {"ok": True, "db": True}

    for module in (boards, members, devices, messages, inbox, docs, zones, tasks, files, feed):
        app.include_router(module.router, prefix="/v1")
    mount_web(app, config.web_dir)

    @app.exception_handler(ApiError)
    async def api_error(_: Request, error: ApiError):
        return _error(error.status, error.code, error.message, error.headers)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, error: RequestValidationError):
        return _error(422, "validation_failed", _describe(list(error.errors())))

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, error: StarletteHTTPException):
        code = "not_found" if error.status_code in (404, 405) else "internal"
        message = "no such endpoint" if error.status_code == 404 else str(error.detail)
        return _error(error.status_code, code, message)

    @app.exception_handler(Exception)
    async def unexpected(_: Request, error: Exception):
        log.exception("unhandled error", exc_info=error)
        return _error(500, "internal", "internal server error")

    return app
