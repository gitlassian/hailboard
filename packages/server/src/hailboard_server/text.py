"""Text that members write and others are shown: what in it is not meant to be read."""

import re

# Control characters, and the characters that change the direction or the breaking of text. In a
# name they hide what a thing is ("report\u202egpj.exe" reads as "reportexe.jpg"); in anything
# shown on one line they can fake the next line of a listing.
HIDDEN = re.compile("[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]")


def has_control(text: str) -> bool:
    """True when the text holds characters that are not meant to be read."""
    return HIDDEN.search(text) is not None


def one_line(text: str) -> str:
    """The text on one line: any run of whitespace, line breaks included, becomes one space, and
    what cannot be read is taken out."""
    return HIDDEN.sub("", " ".join(text.split()))
