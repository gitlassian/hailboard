"""The activity events posted when someone joins a board or adds an agent.

They are ordinary messages of kind `activity` with no recipients: they show up in the feed and in
`hailboard log`, but never in anyone's inbox, so they cost the agents nothing.
"""

from dataclasses import dataclass

from psycopg import AsyncConnection

# The label of the invite that is created together with the board.
INITIAL_INVITE_LABEL = "initial invite"


@dataclass(frozen=True)
class Invite:
    label: str | None
    # Handle of the member who issued the invite; None when nobody on the board did.
    issued_by: str | None


def _and_list(items: list[str]) -> str:
    return items[0] if len(items) == 1 else f"{', '.join(items[:-1])} and {items[-1]}"


def _with_agents(agents: list[str]) -> str:
    if not agents:
        return ""
    noun = "the agent" if len(agents) == 1 else "the agents"
    return f" with {noun} {_and_list(agents)}"


def _through(invite: Invite) -> str:
    if invite.label == INITIAL_INVITE_LABEL:
        return " through the invite created with the board"
    label = invite.label
    if invite.issued_by and label:
        return f' through the invite "{label}" from {invite.issued_by}'
    if invite.issued_by:
        return f" through an invite from {invite.issued_by}"
    if label:
        return f' through the invite "{label}"'
    return " through the invite created with the board"


def join_text(
    owner: str,
    agents: list[str],
    *,
    created_board: bool,
    invite: Invite,
    wanted_owner: str | None = None,
) -> str:
    """One sentence for the feed: who joined, with which agents, how, and under what name.

    Handles are written without "@" so the event reads as a note, not as a message to them.
    """
    if created_board:
        text = f"{owner} created the board"
        if agents:
            text += f" and joined{_with_agents(agents)}"
    else:
        text = f"{owner} joined{_with_agents(agents)}{_through(invite)}"
    if wanted_owner and wanted_owner != owner:
        text += f' (the name "{wanted_owner}" was taken)'
    return text + "."


def request_text(
    owner: str,
    agents: list[str],
    *,
    invite: Invite,
    board_owner: str,
    wanted_owner: str | None = None,
) -> str:
    """What the owner reads when someone asks to join through an invite that needs approval."""
    taken = (
        f' (the name "{wanted_owner}" was taken)' if wanted_owner and wanted_owner != owner else ""
    )
    return (
        f"{owner} asks to join{_with_agents(agents)}{_through(invite)}{taken}. Only {board_owner} "
        f"can let them in, in a terminal: hailboard accept {owner} (or: hailboard decline "
        f"{owner})."
    )


def agent_added_text(owner: str, agent: str) -> str:
    return f"{owner} added the agent {agent}."


async def post_activity(conn: AsyncConnection, board_id: str, author_id: str, body: str) -> None:
    """Posts an activity event inside the caller's transaction. It has no recipients."""
    await conn.execute(
        "insert into messages (board_id, author_id, kind, body) values (%s, %s, 'activity', %s)",
        (board_id, author_id, body),
    )
