import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    database_url: str
    host: str = "127.0.0.1"
    port: int = 8080
    # Base URL used to build invite and feed links in API responses.
    public_url: str = "http://localhost:8080"
    # Apply the SQL migrations on startup.
    auto_migrate: bool = False
    # Rate limits on board creation, joining, failed logins and posting. Off by default for
    # code that builds a Config directly (tests); load_config turns them on unless RATE_LIMITS=off.
    rate_limits: bool = False
    # The server sits behind a reverse proxy that sets X-Forwarded-For (TRUST_PROXY=true).
    trust_proxy: bool = False
    # Directory with the built web feed (packages/web/dist). None: look next to the sources.
    web_dir: str | None = None
    # The content of the files of all boards together (FILES_TOTAL_MB).
    files_total_bytes: int = 2048 * 1024 * 1024


def load_config(env: dict[str, str] | None = None) -> Config:
    env = dict(os.environ) if env is None else env
    database_url = env.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required")

    raw_port = env.get("PORT", "8080")
    try:
        port = int(raw_port)
    except ValueError:
        port = 0
    if not 1 <= port <= 65535:
        raise RuntimeError(f'PORT must be a valid port number, got "{raw_port}"')

    raw_total = env.get("FILES_TOTAL_MB", "2048")
    if not raw_total.isdigit():
        raise RuntimeError(f'FILES_TOTAL_MB must be a whole number, got "{raw_total}"')

    return Config(
        database_url=database_url,
        host=env.get("HOST", "127.0.0.1"),
        port=port,
        public_url=env.get("PUBLIC_URL", f"http://localhost:{port}").rstrip("/"),
        auto_migrate=env.get("AUTO_MIGRATE") == "true",
        rate_limits=env.get("RATE_LIMITS", "on") != "off",
        trust_proxy=env.get("TRUST_PROXY") == "true",
        web_dir=env.get("WEB_DIR") or None,
        files_total_bytes=int(raw_total) * 1024 * 1024,
    )
