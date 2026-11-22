"""In-memory rate limiting.

The server runs as a single process, so counters live in memory and are lost on restart; that is
acceptable for abuse protection (nothing here needs to be exact or durable). Each limit is a
sliding window over the timestamps of recent hits.
"""

import math
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass

from fastapi import Request

from .errors import ApiError

# Drop idle keys once the table grows past this, so memory stays bounded under a flood of IPs.
MAX_TRACKED_KEYS = 50_000


@dataclass(frozen=True)
class Limit:
    name: str
    max_hits: int
    window_seconds: float


# Defaults protect an open, unauthenticated board creation endpoint and credential guessing
# while staying far above what a team of agents does in normal use.
BOARDS_PER_IP = Limit("boards", 10, 3600)
JOINS_PER_IP = Limit("joins", 60, 3600)
INVITE_LOOKUPS_PER_IP = Limit("invite_lookups", 300, 3600)
AUTH_FAILURES_PER_IP = Limit("auth_failures", 20, 300)
MESSAGES_PER_MEMBER = Limit("messages", 120, 60)
FILES_PER_MEMBER = Limit("files", 30, 3600)


class RateLimiter:
    def __init__(self, enabled: bool = True, clock: Callable[[], float] = time.monotonic):
        self.enabled = enabled
        self._clock = clock
        self._hits: dict[tuple[str, str], deque[float]] = {}

    def _recent(self, limit: Limit, key: str) -> deque[float]:
        hits = self._hits.setdefault((limit.name, key), deque())
        cutoff = self._clock() - limit.window_seconds
        while hits and hits[0] <= cutoff:
            hits.popleft()
        return hits

    def _prune(self) -> None:
        if len(self._hits) <= MAX_TRACKED_KEYS:
            return
        now = self._clock()
        windows = {limit.name: limit.window_seconds for limit in _ALL}
        for key in [
            k
            for k, hits in self._hits.items()
            if not hits or hits[-1] <= now - windows.get(k[0], 3600)
        ]:
            del self._hits[key]

    def retry_after(self, limit: Limit, key: str) -> int:
        """Seconds until one more hit would be allowed; 0 when the limit is not reached."""
        if not self.enabled:
            return 0
        hits = self._recent(limit, key)
        if len(hits) < limit.max_hits:
            return 0
        return max(1, math.ceil(hits[0] + limit.window_seconds - self._clock()))

    def hit(self, limit: Limit, key: str) -> None:
        """Counts one event without checking the limit (used for failures)."""
        if not self.enabled:
            return
        self._prune()
        self._recent(limit, key).append(self._clock())

    def check(self, limit: Limit, key: str, what: str) -> None:
        """Counts one event and raises 429 when the limit is exceeded."""
        wait = self.retry_after(limit, key)
        if wait:
            raise too_many(what, wait)
        self.hit(limit, key)


_ALL = (
    BOARDS_PER_IP,
    JOINS_PER_IP,
    INVITE_LOOKUPS_PER_IP,
    AUTH_FAILURES_PER_IP,
    MESSAGES_PER_MEMBER,
)


def too_many(what: str, retry_after: int) -> ApiError:
    return ApiError(
        "rate_limited",
        f"too many {what}; try again in {retry_after} seconds",
        headers={"Retry-After": str(retry_after)},
    )


def client_ip(request: Request) -> str:
    """The caller's address. Behind our own proxy (TRUST_PROXY=true) the proxy appends the real
    address to X-Forwarded-For, so the last entry is the one that cannot be forged by the caller."""
    if request.app.state.config.trust_proxy:
        forwarded = request.headers.get("x-forwarded-for", "")
        last = forwarded.split(",")[-1].strip()
        if last:
            return last
    return request.client.host if request.client else "unknown"


def limiter(request: Request) -> RateLimiter:
    return request.app.state.limiter
