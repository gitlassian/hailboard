"""Serves the web feed (the built `packages/web`) next to the API.

The page lives at the links the API hands out: `/feed/<read token>` shows a board's feed and
`/join/<join token>` explains how to join. The token stays in the path; the page reads it there
and calls `/v1/feed/...`. Responses forbid sending the URL on as a referrer, caching and
indexing, because the URL is the secret.
"""

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from starlette.staticfiles import StaticFiles

log = logging.getLogger("hailboard")

# packages/server/src/hailboard_server/web.py -> packages/web/dist
DEV_WEB_DIR = Path(__file__).resolve().parents[3] / "web" / "dist"

PAGE_HEADERS = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    ),
}


class ImmutableStaticFiles(StaticFiles):
    """Built assets carry a content hash in their name, so browsers may keep them forever."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response


def mount_web(app: FastAPI, web_dir: str | None) -> None:
    root = Path(web_dir) if web_dir else DEV_WEB_DIR
    index = root / "index.html"
    if not index.is_file():
        log.warning("web feed not found in %s; /feed and /join links will not open a page", root)

        async def missing(token: str):
            return JSONResponse(
                {
                    "error": {
                        "code": "not_found",
                        "message": "the web feed is not built on this server "
                        "(pnpm --filter @hailboard/web build)",
                    }
                },
                status_code=404,
                headers={"Referrer-Policy": "no-referrer", "Cache-Control": "no-store"},
            )

        app.add_api_route("/feed/{token}", missing, methods=["GET"], include_in_schema=False)
        app.add_api_route("/join/{token}", missing, methods=["GET"], include_in_schema=False)
        return

    async def page(token: str):
        return FileResponse(index, media_type="text/html", headers=PAGE_HEADERS)

    app.add_api_route("/feed/{token}", page, methods=["GET"], include_in_schema=False)
    app.add_api_route("/join/{token}", page, methods=["GET"], include_in_schema=False)
    if (root / "assets").is_dir():
        app.mount("/assets", ImmutableStaticFiles(directory=root / "assets"), name="assets")
    log.info("serving the web feed from %s", root)
