"""Request and response models of API v1. FastAPI turns them into the OpenAPI description."""

from datetime import datetime
from typing import Annotated, Literal
from zoneinfo import available_timezones

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)

from .handles import parse_handle
from .text import one_line

MAX_BODY_LENGTH = 8000
MAX_STATUS_LENGTH = 200
MAX_DISPLAY_NAME_LENGTH = 64
MAX_TITLE_LENGTH = 40
MAX_BOARD_NAME_LENGTH = 80
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100
DEFAULT_WAIT_SECONDS = 50
MAX_WAIT_SECONDS = 55  # below the usual 60 second proxy timeout
MAX_WAITS_PER_MEMBER = 10
MAX_AGENTS_PER_OWNER = 8
MAX_DOCUMENT_LENGTH = 100_000
MAX_DOCUMENT_NAME_LENGTH = 120
MAX_ZONE_NAME_LENGTH = 80
MAX_ZONE_NOTE_LENGTH = 300
MAX_ZONE_PATHS = 20
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_FILE_NAME_LENGTH = 200
MAX_FILE_RECIPIENTS = 10
MAX_FILE_NOTE_LENGTH = 500
# How long the content of a file is kept.
FILE_DAYS = 7
# The content of all files a board holds at one time.
MAX_BOARD_FILE_BYTES = 200 * 1024 * 1024
MAX_TASK_TITLE_LENGTH = 200
MAX_TASK_PART_LENGTH = 80
# Tasks that are not done yet, per board.
MAX_OPEN_TASKS = 200
# Finished tasks are kept, but a listing carries only the latest of them.
MAX_DONE_TASKS_LISTED = 100
MAX_ZONE_PATH_LENGTH = 200
MAX_ZONES_PER_MEMBER = 20
MAX_CHECK_PATHS = 50
# A zone whose owner has not been seen for this long is reported as stale.
ZONE_STALE_HOURS = 6
# "plan.md", "api/users.md": path-like, each part starting with a letter or digit.
DOCUMENT_NAME_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$"

MemberKind = Literal["human", "agent"]
TokenScope = Literal["join", "read"]
MemberRole = Literal["owner", "member"]
MemberState = Literal["pending", "active"]
# How long an invite works when its creator does not say.
DEFAULT_INVITE_DAYS = 7
MAX_INVITE_USES = 1000
InboxReason = Literal["mention", "human", "all", "reply"]


def _check_handle(value: str) -> str:
    if parse_handle(value) is None:
        raise ValueError(
            'must look like "alice" (human) or "alice/claude" (agent): '
            'lowercase letters, digits, "-"'
        )
    return value


def _check_agent_name(value: str) -> str:
    parsed = parse_handle(f"owner/{value}")
    if parsed is None or parsed.kind != "agent":
        raise ValueError('must be a lowercase name like "codex": letters, digits, "-"')
    return value


def _check_owner(value: str) -> str:
    parsed = parse_handle(value)
    if parsed is None or parsed.kind != "human":
        raise ValueError('must be a lowercase name like "alice"')
    return value


Handle = Annotated[str, AfterValidator(_check_handle)]
Stripped = StringConstraints(strip_whitespace=True)


# Names, titles, notes and statuses are shown on one line (listings, board events, an agent's
# context). With a line break in them a member could write what looks like the next entry of a
# listing. Put it before the length limits, so that they count what is left.
OneLine = BeforeValidator(lambda value: one_line(value) if isinstance(value, str) else value)
Owner = Annotated[str, AfterValidator(_check_owner)]
AgentName = Annotated[str, AfterValidator(_check_agent_name)]


# IANA names, old aliases included (the tzdata package has them; Node reports "Europe/Kiev").
# Read once: the scan walks the file system. Not the server's own "localtime".
TIMEZONES = frozenset(available_timezones()) - {"localtime", "Factory", "posixrules"}


def _known_timezone(value: str | None) -> str | None:
    if value is not None and value not in TIMEZONES:
        raise ValueError("not a time zone name such as Europe/Kyiv or America/New_York")
    return value


def _timezone_or_none(value: object) -> object:
    # What a joining machine reports is a hint: an unknown zone is dropped, not a failed join.
    return value if isinstance(value, str) and value in TIMEZONES else None


# --------------------------------------------------------------------------- requests


class CreateBoardRequest(BaseModel):
    name: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_BOARD_NAME_LENGTH),
        OneLine,
    ]


class JoinMember(BaseModel):
    handle: Handle
    kind: MemberKind


class JoinBoardRequest(BaseModel):
    join_token: Annotated[str, Field(min_length=1)]
    owner: Owner
    members: Annotated[list[JoinMember], Field(min_length=1, max_length=4)]
    # The name the person asked for, when it was taken and `owner` is a variant of it ("bob" for
    # "bob-2"). Only used to explain the name in the join event.
    wanted_owner: Owner | None = None
    # The joining machine's time zone: the person's profile starts with it.
    timezone: Annotated[str | None, BeforeValidator(_timezone_or_none)] = None

    @model_validator(mode="after")
    def _members_match_owner(self) -> "JoinBoardRequest":
        seen: set[str] = set()
        for member in self.members:
            parsed = parse_handle(member.handle)
            if parsed is None:
                continue
            if parsed.kind != member.kind:
                raise ValueError(f'handle "{member.handle}" is a {parsed.kind} handle')
            if parsed.owner != self.owner:
                raise ValueError(
                    f'handle "{member.handle}" must start with the owner "{self.owner}"'
                )
            if member.handle in seen:
                raise ValueError(f'duplicate handle "{member.handle}"')
            seen.add(member.handle)
        return self


class AddAgentRequest(BaseModel):
    name: AgentName


class CreateTokenRequest(BaseModel):
    scope: TokenScope
    label: (
        Annotated[
            str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80), OneLine
        ]
        | None
    ) = None
    expires_in_hours: Annotated[int, Field(ge=1, le=24 * 365)] | None = None
    # An invite that lets people in without the owner's approval. Only the owner can make one.
    open: bool = False
    # How many people the invite can bring in; no limit when not given.
    max_uses: Annotated[int, Field(ge=1, le=MAX_INVITE_USES)] | None = None


class OwnerRequest(BaseModel):
    """Hand the board to another person on it."""

    handle: Owner


class ProfileRequest(BaseModel):
    """Changes to the person's profile. A field that is left out stays; null clears it."""

    display_name: (
        Annotated[
            str,
            StringConstraints(
                strip_whitespace=True, min_length=1, max_length=MAX_DISPLAY_NAME_LENGTH
            ),
            OneLine,
        ]
        | None
    ) = None
    # What they do in the team: "frontend", "design", "backend lead".
    title: (
        Annotated[
            str,
            StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_TITLE_LENGTH),
            OneLine,
        ]
        | None
    ) = None
    # An IANA time zone name.
    timezone: Annotated[str | None, AfterValidator(_known_timezone)] = None


class SetStatusRequest(BaseModel):
    text: (
        Annotated[
            str, StringConstraints(strip_whitespace=True, max_length=MAX_STATUS_LENGTH), OneLine
        ]
        | None
    )


def _not_blank(value: str) -> str:
    if not value.strip():
        raise ValueError("must not be empty")
    return value


class PostMessageRequest(BaseModel):
    body: Annotated[str, Field(max_length=MAX_BODY_LENGTH), AfterValidator(_not_blank)]
    reply_to: Annotated[int, Field(ge=1)] | None = None
    kind: Literal["message", "human_request"] = "message"


class WriteDocumentRequest(BaseModel):
    body: Annotated[str, Field(max_length=MAX_DOCUMENT_LENGTH)]
    # The version the writer started from. When the document has changed since, the write is
    # refused with 409 so nobody overwrites a teammate's change unseen. Omit to overwrite.
    base_version: Annotated[int, Field(ge=0)] | None = None
    # Pin (true) or unpin (false) the document as board context; omit to leave it as it is.
    pinned: bool | None = None


class AckInboxRequest(BaseModel):
    up_to: Annotated[int, Field(ge=0)]


# -------------------------------------------------------------------------- responses


class BoardRef(BaseModel):
    id: str
    name: str


class InviteInfo(BaseModel):
    """What an invite link leads to, for the join page. Holds no secrets."""

    board: BoardRef
    label: str | None
    expires_at: datetime | None
    # Whether the board's owner lets each newcomer in.
    requires_approval: bool = False


class BoardCreated(BaseModel):
    board: BoardRef
    join_token: str
    read_token: str
    join_url: str
    feed_url: str


class JoinedMember(BaseModel):
    id: str
    handle: str
    kind: MemberKind
    api_key: str


class JoinResult(BaseModel):
    board: BoardRef
    members: list[JoinedMember]
    # "pending" when the invite needs the owner's approval: the keys work once they let you in.
    state: MemberState = "active"
    board_owner: str | None = None


class TokenCreated(BaseModel):
    id: str
    scope: TokenScope
    token: str
    url: str
    expires_at: datetime | None
    requires_approval: bool = False
    max_uses: int | None = None


class TokenOut(BaseModel):
    """An invite or feed link, without its secret."""

    id: str
    scope: TokenScope
    label: str | None
    created_by: str | None
    created_at: datetime
    expires_at: datetime | None
    revoked_at: datetime | None
    uses: int
    max_uses: int | None
    requires_approval: bool
    # Still lets people in (or read): not revoked, not expired, not used up.
    active: bool


class TokensResponse(BaseModel):
    tokens: list[TokenOut]


class SecurityEvent(BaseModel):
    kind: str
    actor: str | None
    subject: str | None
    data: dict
    created_at: datetime


class SecurityEventsResponse(BaseModel):
    events: list[SecurityEvent]


class MemberSelf(BaseModel):
    id: str
    handle: str
    kind: MemberKind
    owner: str
    status_text: str | None
    role: MemberRole = "member"
    state: MemberState = "active"
    display_name: str | None = None
    title: str | None = None
    timezone: str | None = None


DeviceName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64), OneLine
]


class MakeDeviceCodeRequest(BaseModel):
    # The name of the machine the request comes from, if its keys have none yet.
    device: DeviceName | None = None


class RedeemDeviceRequest(BaseModel):
    code: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    # What the person calls the new machine; shown by `hailboard device list`.
    device: DeviceName


class DeviceCode(BaseModel):
    """A one-time code that brings another machine of the person onto the board."""

    code: str
    url: str
    expires_at: datetime


class DeviceInfo(BaseModel):
    """What a device code is for, without using it. Holds no secrets."""

    board: BoardRef
    owner: str
    expires_at: datetime


class DeviceJoined(BaseModel):
    """Keys for the new machine: the person's and each of their agents'. Shown only once."""

    board: BoardRef
    owner: str
    device: str
    members: list[JoinedMember]


class DeviceOut(BaseModel):
    # None for the person's first machine, whose keys were made before devices had names.
    name: str | None
    created_at: datetime
    last_used_at: datetime | None
    # The machine the request came from.
    current: bool


class DevicesResponse(BaseModel):
    devices: list[DeviceOut]


class Me(BaseModel):
    member: MemberSelf
    board: BoardRef
    # The handle of the person who owns the board: who lets people in.
    board_owner: str | None = None


class MemberOut(BaseModel):
    handle: str
    kind: MemberKind
    status_text: str | None
    last_seen_at: datetime | None
    # The last request that was not a wait for messages: when the member last did something.
    last_active_at: datetime | None
    joined_at: datetime
    # The number of the last message addressed to this member that reached them (their read
    # cursor). Everything addressed to them up to it has been seen.
    read_up_to: int
    online: bool
    role: MemberRole = "member"
    state: MemberState = "active"
    # The person's profile (agents have none; see the person's entry).
    display_name: str | None = None
    title: str | None = None
    timezone: str | None = None
    # The named machines the member's keys work on, the most recently used first. A person's
    # first machine has no name until they add a second one, so one machine usually means an
    # empty list. Not shown on the read-only feed.
    machines: list[str] = []


class MembersResponse(BaseModel):
    members: list[MemberOut]


class FileRef(BaseModel):
    """A file as a message shows it: enough to name it and to ask for it."""

    number: int
    name: str
    size: int
    expires_at: datetime
    # False once the content is gone: the time is up, or the sender took the file back.
    available: bool


class Message(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    seq: int
    from_: str = Field(alias="from")
    kind: Literal["message", "human_request", "activity"]
    body: str
    mentions: list[str]
    # Everyone the message was addressed to, and those of them it has reached so far.
    recipients: list[str]
    seen_by: list[str]
    mention_all: bool
    mention_humans: bool
    reply_to: int | None
    created_at: datetime
    # Files sent with the message. Only its recipients and its sender can download them.
    files: list[FileRef] = []


class InboxMessage(Message):
    reason: InboxReason


class PostMessageResponse(BaseModel):
    message: Message
    # Handles written as @mentions that do not exist on this board (typos, "@types/node").
    unknown_mentions: list[str]


class MessagesPage(BaseModel):
    messages: list[Message]
    next_after: int


class InboxResult(BaseModel):
    messages: list[InboxMessage]
    remaining: int


class DocumentInfo(BaseModel):
    name: str
    version: int
    size: int
    pinned: bool
    updated_by: str
    updated_at: datetime


class Document(DocumentInfo):
    body: str


class DocumentsResponse(BaseModel):
    documents: list[DocumentInfo]


class ClaimZoneRequest(BaseModel):
    # Without a name the first path names the zone.
    name: (
        Annotated[str, Stripped, OneLine, Field(min_length=1, max_length=MAX_ZONE_NAME_LENGTH)]
        | None
    ) = None
    paths: Annotated[
        list[Annotated[str, Stripped, Field(min_length=1, max_length=MAX_ZONE_PATH_LENGTH)]],
        Field(min_length=1, max_length=MAX_ZONE_PATHS),
    ]
    note: Annotated[str, Stripped, OneLine, Field(max_length=MAX_ZONE_NOTE_LENGTH)] | None = None


class Zone(BaseModel):
    id: str
    name: str
    note: str | None
    paths: list[str]
    owner: str
    claimed_at: datetime
    # The owner has not been seen for a while, so the claim may be forgotten.
    stale: bool


class ZoneOverlap(BaseModel):
    zone: Zone
    # The paths of the new claim that meet the other zone.
    paths: list[str]


class ClaimResult(BaseModel):
    zone: Zone
    overlaps: list[ZoneOverlap]


class ZonesResponse(BaseModel):
    zones: list[Zone]


class ZoneConflict(BaseModel):
    path: str
    zone: Zone


class ZoneCheck(BaseModel):
    conflicts: list[ZoneConflict]


class FileInfo(FileRef):
    model_config = ConfigDict(populate_by_name=True)

    sha256: str
    from_: str = Field(alias="from")
    to: list[str]
    # The message that carries the file.
    seq: int
    created_at: datetime
    # Null: the server stores the content as it was sent.
    encryption: str | None


class FilesResponse(BaseModel):
    files: list[FileInfo]


class FileSent(BaseModel):
    file: FileInfo
    message: Message


TaskState = Literal["todo", "doing", "done"]


class AddTaskRequest(BaseModel):
    title: Annotated[str, OneLine, Field(min_length=1, max_length=MAX_TASK_TITLE_LENGTH)]
    # The part of the project the task belongs to: free text, usually the name of a zone.
    part: Annotated[str, OneLine, Field(min_length=1, max_length=MAX_TASK_PART_LENGTH)] | None = (
        None
    )
    # Take the task at once: it starts as "doing" with the caller on it.
    take: bool = False


class Task(BaseModel):
    number: int
    title: str
    part: str | None
    state: TaskState
    # Who works on it now (doing), or who did it (done), in the order they took it.
    agents: list[str]
    created_by: str
    created_at: datetime
    updated_at: datetime
    done_at: datetime | None


class TasksResponse(BaseModel):
    tasks: list[Task]


class ErrorBody(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorBody
