import asyncio
import time
from typing import ClassVar

import pytest
from pydantic import ValidationError

from hailboard_server.handles import parse_handle
from hailboard_server.joins import Invite, agent_added_text, join_text
from hailboard_server.mentions import parse_mentions
from hailboard_server.pubsub import Waker
from hailboard_server.schemas import (
    MAX_BODY_LENGTH,
    AckInboxRequest,
    JoinBoardRequest,
    PostMessageRequest,
)


class TestParseHandle:
    def test_human(self):
        parsed = parse_handle("alice")
        assert parsed is not None
        assert (parsed.kind, parsed.owner, parsed.handle) == ("human", "alice", "alice")

    def test_agent(self):
        parsed = parse_handle("alice/claude")
        assert parsed is not None
        assert (parsed.kind, parsed.owner, parsed.name) == ("agent", "alice", "claude")

    @pytest.mark.parametrize(
        "value",
        ["", "Alice", "alice/", "/claude", "alice/claude/x", "-alice", "al ice", "all", "human"],
    )
    def test_rejects(self, value):
        assert parse_handle(value) is None

    def test_reserved_owner_on_agent(self):
        assert parse_handle("all/claude") is None

    def test_length_limit(self):
        assert parse_handle("a" * 32) is not None
        assert parse_handle("a" * 33) is None

    def test_trailing_newline_is_not_allowed(self):
        assert parse_handle("alice\n") is None


class TestParseMentions:
    def test_humans_and_agents(self):
        m = parse_mentions("@bob/codex please ask @alice")
        assert (m.handles, m.all, m.humans) == (["bob/codex", "alice"], False, False)

    def test_all_and_human(self):
        m = parse_mentions("@all heads up, @human needs a decision")
        assert (m.handles, m.all, m.humans) == ([], True, True)

    def test_lowercases_and_deduplicates(self):
        assert parse_mentions("@Bob/Codex then @bob/codex again").handles == ["bob/codex"]

    def test_trailing_punctuation(self):
        assert parse_mentions("ping @bob/codex, @alice.").handles == ["bob/codex", "alice"]

    def test_ignores_emails_scoped_packages_and_paths(self):
        assert parse_mentions("write to dev@example.com").handles == []
        assert parse_mentions("import pkg/@scope/name").handles == []
        assert parse_mentions("see a/@b").handles == []

    def test_ignores_parts_longer_than_32(self):
        assert parse_mentions("@" + "a" * 33).handles == []

    def test_at_the_start(self):
        assert parse_mentions("@alice hi").handles == ["alice"]


class TestSchemas:
    base: ClassVar[dict[str, str]] = {"join_token": "inv_x", "owner": "alice"}

    def test_join_accepts_human_and_agent(self):
        JoinBoardRequest.model_validate(
            {
                **self.base,
                "members": [
                    {"handle": "alice", "kind": "human"},
                    {"handle": "alice/claude", "kind": "agent"},
                ],
            }
        )

    @pytest.mark.parametrize(
        "members",
        [
            [{"handle": "bob/codex", "kind": "agent"}],  # wrong owner
            [{"handle": "alice/claude", "kind": "human"}],  # kind does not match
            [{"handle": "alice", "kind": "human"}] * 2,  # duplicate
            [],
        ],
    )
    def test_join_rejects(self, members):
        with pytest.raises(ValidationError):
            JoinBoardRequest.model_validate({**self.base, "members": members})

    @pytest.mark.parametrize("owner", ["alice/x", "all", "Alice"])
    def test_join_rejects_bad_owner(self, owner):
        with pytest.raises(ValidationError):
            JoinBoardRequest.model_validate(
                {
                    "join_token": "t",
                    "owner": owner,
                    "members": [{"handle": "alice", "kind": "human"}],
                }
            )

    def test_message_defaults_and_limits(self):
        assert PostMessageRequest.model_validate({"body": "hi"}).kind == "message"
        for bad in (
            {"body": "   "},
            {"body": "x" * (MAX_BODY_LENGTH + 1)},
            {"body": "x", "kind": "activity"},
        ):
            with pytest.raises(ValidationError):
                PostMessageRequest.model_validate(bad)
        PostMessageRequest.model_validate({"body": "x" * MAX_BODY_LENGTH})

    def test_ack_needs_non_negative(self):
        AckInboxRequest.model_validate({"up_to": 3})
        with pytest.raises(ValidationError):
            AckInboxRequest.model_validate({"up_to": -1})


class TestWaker:
    async def test_remembers_a_signal_sent_before_waiting(self):
        waker = Waker()
        waker.signal()
        start = time.monotonic()
        await waker.wait(2)
        assert time.monotonic() - start < 0.5

    async def test_wakes_and_times_out(self):
        waker = Waker()
        asyncio.get_running_loop().call_later(0.02, waker.signal)
        start = time.monotonic()
        await waker.wait(5)
        assert time.monotonic() - start < 1

        start = time.monotonic()
        await Waker().wait(0.06)
        assert time.monotonic() - start >= 0.05

    async def test_each_signal_wakes_once(self):
        waker = Waker()
        waker.signal()
        await waker.wait(1)
        start = time.monotonic()
        await waker.wait(0.1)  # the earlier signal was consumed
        assert time.monotonic() - start >= 0.09


class TestJoinText:
    def test_created_the_board_without_an_agent(self):
        text = join_text("alice", [], created_board=True, invite=Invite("initial invite", None))
        assert text == "alice created the board."

    def test_invite_without_a_label(self):
        text = join_text("bob", [], created_board=False, invite=Invite(None, "alice"))
        assert text == "bob joined through an invite from alice."

    def test_labelled_invite_of_unknown_issuer(self):
        text = join_text("bob", ["bob/codex"], created_board=False, invite=Invite("team", None))
        assert text == 'bob joined with the agent bob/codex through the invite "team".'

    def test_three_agents_and_the_same_name(self):
        text = join_text(
            "bob",
            ["bob/a", "bob/b", "bob/c"],
            created_board=False,
            invite=Invite(None, None),
            wanted_owner="bob",
        )
        assert text == (
            "bob joined with the agents bob/a, bob/b and bob/c"
            " through the invite created with the board."
        )

    def test_agent_added(self):
        assert agent_added_text("alice", "alice/codex") == "alice added the agent alice/codex."
