"""Writes the server's OpenAPI description to a file.

    uv run python scripts/export_openapi.py OUT.json

The TypeScript client types are generated from this file (`pnpm gen:api` in the repository root).
"""

import json
import sys
from pathlib import Path

from hailboard_server.app import create_app
from hailboard_server.config import Config


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: export_openapi.py OUT.json")
    # The app is only built here, never started, so no database is needed.
    app = create_app(Config(database_url="postgres://unused/unused"))
    Path(sys.argv[1]).write_text(json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
