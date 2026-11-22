import re
from dataclasses import dataclass
from typing import Literal

_PART = r"[a-z0-9][a-z0-9-]{0,31}"
_OWNER_RE = re.compile(_PART)
_AGENT_RE = re.compile(rf"({_PART})/({_PART})")

# Names that cannot be used as an owner because they are mention keywords.
RESERVED_NAMES = frozenset({"all", "human"})


@dataclass(frozen=True)
class ParsedHandle:
    kind: Literal["human", "agent"]
    owner: str
    handle: str
    name: str | None = None


def parse_handle(handle: str) -> ParsedHandle | None:
    """Parses "alice" (a human) or "alice/claude" (an agent owned by alice).

    Returns None when the text is not a valid handle. Mirrors the checks in the database.
    """
    agent = _AGENT_RE.fullmatch(handle)
    if agent:
        owner, name = agent.group(1), agent.group(2)
        if owner in RESERVED_NAMES:
            return None
        return ParsedHandle("agent", owner, handle, name)
    if _OWNER_RE.fullmatch(handle) and handle not in RESERVED_NAMES:
        return ParsedHandle("human", handle, handle)
    return None
