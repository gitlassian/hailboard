"""Paths and globs of ownership zones: normalising them and telling whether two of them meet.

A zone path is relative to the repository root and is a file ("src/api.ts"), a directory
("web/checkout", which covers everything below it) or a glob ("web/**/*.css"). The checks are
deliberately cautious: a false warning costs a message, a missed overlap costs a merge conflict.
"""

import re
from functools import lru_cache

from .errors import invalid
from .text import has_control

_WILDCARDS = re.compile(r"[*?\[]")


def normalize(path: str, *, shown: bool = True) -> str:
    """A path as a clean, relative, forward-slash string. Raises an invalid-request error.

    A path that is stored is `shown`: it is printed on one line in listings, in board events and
    in an agent's context, so it may not hold line breaks or other characters that are not read.
    A path that is only looked up (the check before an edit) may be any file name.
    """
    if has_control(path.strip()) if shown else "\x00" in path:
        raise invalid("path: a path has no line breaks or control characters")
    text = path.strip().replace("\\", "/")
    while text.startswith("./"):
        text = text[2:]
    if text.startswith("/") or re.match(r"^[A-Za-z]:/", text):
        raise invalid(f'path "{path}": use a path relative to the repository root')
    parts = [part for part in text.split("/") if part not in ("", ".")]
    if not parts or ".." in parts:
        raise invalid(f'path "{path}": not a usable path inside the repository')
    return "/".join(parts)


def literal_prefix(path: str) -> list[str]:
    """The leading directories of a normalised path that contain no wildcard."""
    prefix: list[str] = []
    for part in path.split("/"):
        if _WILDCARDS.search(part):
            break
        prefix.append(part)
    return prefix


def _one_inside_the_other(a: list[str], b: list[str]) -> bool:
    shorter = min(len(a), len(b))
    return a[:shorter] == b[:shorter]


def overlaps(a: str, b: str) -> bool:
    """Whether two normalised zone paths can cover the same file."""
    return _one_inside_the_other(literal_prefix(a), literal_prefix(b))


@lru_cache(maxsize=512)
def _regex(glob: str) -> re.Pattern[str]:
    out: list[str] = []
    i = 0
    while i < len(glob):
        ch = glob[i]
        if glob.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
            continue
        if glob.startswith("**", i):
            out.append(".*")
            i += 2
            continue
        if ch == "*":
            out.append("[^/]*")
        elif ch == "?":
            out.append("[^/]")
        else:
            out.append(re.escape(ch))
        i += 1
    # A match on a directory covers everything below it.
    return re.compile("".join(out) + "(?:/.*)?")


def covers(zone_path: str, file: str) -> bool:
    """Whether a zone path covers a normalised file path."""
    return _regex(zone_path).fullmatch(file) is not None
