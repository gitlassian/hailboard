import re
from dataclasses import dataclass, field

# "@" must not follow a word character, "@", "/" or "-" (so e-mail addresses and paths like
# "pkg/@scope" are not mentions). The handle is "name" or "name/name", each part up to 32 chars.
_MENTION_RE = re.compile(
    r"(?<![\w@/-])@([a-z0-9][a-z0-9-]{0,31}(?:/[a-z0-9][a-z0-9-]{0,31})?)(?![\w-])",
    re.IGNORECASE | re.ASCII,
)


@dataclass
class ParsedMentions:
    # Explicitly mentioned handles ("alice", "alice/claude"), lowercase, in first-seen order.
    handles: list[str] = field(default_factory=list)
    # The text contains @all.
    all: bool = False
    # The text contains @human.
    humans: bool = False


def parse_mentions(body: str) -> ParsedMentions:
    """Extracts @mentions from a message body. Does not check that the members exist."""
    result = ParsedMentions()
    for match in _MENTION_RE.finditer(body):
        handle = match.group(1).lower()
        if handle == "all":
            result.all = True
        elif handle == "human":
            result.humans = True
        elif handle not in result.handles:
            result.handles.append(handle)
    return result
