import logging

import uvicorn

from .config import load_config


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    config = load_config()
    uvicorn.run(
        "hailboard_server.app:create_app",
        factory=True,
        host=config.host,
        port=config.port,
        timeout_graceful_shutdown=5,
    )


if __name__ == "__main__":
    main()
