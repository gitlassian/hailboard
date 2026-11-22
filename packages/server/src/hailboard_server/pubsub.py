import asyncio
import contextlib
import logging
from collections.abc import Callable

import psycopg

log = logging.getLogger(__name__)

INBOX_CHANNEL = "hailboard_inbox"
BOARD_CHANNEL = "hailboard_board"

Listener = Callable[[], None]


class Waker:
    """Wakes one waiter. A signal that arrives while nobody is waiting is remembered, so a
    notification between "check the database" and "start waiting" is never lost."""

    def __init__(self) -> None:
        self._event = asyncio.Event()

    def signal(self) -> None:
        self._event.set()

    async def wait(self, seconds: float) -> None:
        """Returns on the next signal or after `seconds`, whichever comes first."""
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._event.wait(), seconds)
        # No await between the wake-up and the reset: a later signal sets the event again.
        self._event.clear()


class PubSub:
    """Fans PostgreSQL notifications out to in-process subscribers.

    The database triggers announce every new message (channel hailboard_board, payload
    "<board_id>:<seq>") and every new inbox entry (hailboard_inbox, "<member_id>:<seq>") after
    commit. One dedicated LISTEN connection per server process receives them, so this works the
    same with one server or many replicas.

    A notification is only a hint: subscribers always re-read the database, so a lost
    notification (for example during a reconnect) is harmless. Everyone is woken whenever the
    LISTEN connection is (re)established.
    """

    def __init__(self) -> None:
        self._inbox: dict[str, set[Listener]] = {}
        self._board: dict[str, set[Listener]] = {}
        self._task: asyncio.Task[None] | None = None
        self._ready = asyncio.Event()

    def subscribe_inbox(self, member_id: str, listener: Listener) -> Callable[[], None]:
        """Wakes `listener` when something new is addressed to the member."""
        return _add(self._inbox, member_id, listener)

    def subscribe_board(self, board_id: str, listener: Listener) -> Callable[[], None]:
        """Wakes `listener` when a message is posted to the board."""
        return _add(self._board, board_id, listener)

    def wake_all(self) -> None:
        for group in (self._inbox, self._board):
            for listeners in list(group.values()):
                for listener in list(listeners):
                    listener()

    async def start(self, database_url: str) -> None:
        self._task = asyncio.create_task(self._run(database_url))
        await asyncio.wait_for(self._ready.wait(), timeout=15)

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _run(self, database_url: str) -> None:
        while True:
            try:
                async with await psycopg.AsyncConnection.connect(
                    database_url, autocommit=True
                ) as conn:
                    await conn.execute(f"listen {INBOX_CHANNEL}")
                    await conn.execute(f"listen {BOARD_CHANNEL}")
                    self._ready.set()
                    self.wake_all()
                    async for notice in conn.notifies():
                        group = self._inbox if notice.channel == INBOX_CHANNEL else self._board
                        key = notice.payload.rpartition(":")[0]
                        for listener in list(group.get(key, ())):
                            listener()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("LISTEN connection lost, reconnecting")
                await asyncio.sleep(1)


def _add(group: dict[str, set[Listener]], key: str, listener: Listener) -> Callable[[], None]:
    group.setdefault(key, set()).add(listener)

    def unsubscribe() -> None:
        listeners = group.get(key)
        if listeners is None:
            return
        listeners.discard(listener)
        if not listeners:
            del group[key]

    return unsubscribe
