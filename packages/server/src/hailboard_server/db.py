from pathlib import Path

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

MIGRATION_LOCK_ID = 7_766_001


def create_pool(url: str, max_size: int = 10) -> AsyncConnectionPool:
    """A connection pool. Rows are dicts and the session time zone is UTC."""
    return AsyncConnectionPool(
        url,
        min_size=1,
        max_size=max_size,
        open=False,
        kwargs={"row_factory": dict_row, "options": "-c timezone=UTC"},
    )


def migrations_dir() -> Path:
    """The SQL migrations, shipped inside the package."""
    return Path(__file__).resolve().parent / "migrations"


async def migrate(pool: AsyncConnectionPool, directory: Path | None = None) -> list[str]:
    """Applies the SQL files in name order and returns the versions that were applied.

    Each file runs in its own transaction together with its schema_migrations row, so a failing
    file leaves nothing half-applied. An advisory lock makes several servers starting at once
    take turns instead of applying the same file twice.
    """
    directory = directory or migrations_dir()
    async with pool.connection() as conn:
        await conn.execute(
            """create table if not exists schema_migrations (
                 version    text primary key,
                 applied_at timestamptz not null default now()
               )"""
        )

    applied: list[str] = []
    for file in sorted(directory.glob("*.sql")):
        version = file.stem
        async with pool.connection() as conn, conn.transaction():
            await conn.execute("select pg_advisory_xact_lock(%s)", (MIGRATION_LOCK_ID,))
            cur = await conn.execute(
                "select 1 from schema_migrations where version = %s", (version,)
            )
            if await cur.fetchone():
                continue
            await conn.execute(file.read_text(encoding="utf-8"))
            await conn.execute("insert into schema_migrations (version) values (%s)", (version,))
            applied.append(version)
    return applied
