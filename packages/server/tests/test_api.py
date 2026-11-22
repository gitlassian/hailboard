import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from conftest import Api, new_team


async def post(api: Api, key: str, body: str, **extra):
    return await api.call("POST", "/v1/messages", key=key, body={"body": body, **extra})


def seqs(reply):
    return [m["seq"] for m in reply.json["messages"]]


class TestBasics:
    async def test_health_and_version_header(self, api: Api):
        res = await api.call("GET", "/health")
        assert (res.status, res.json) == (200, {"ok": True, "db": True})
        assert res.headers["x-hailboard-version"]

    async def test_unknown_routes_return_json_errors(self, api: Api):
        for path in ("/nope", "/v1/nope"):
            res = await api.call("GET", path)
            assert res.status == 404
            assert res.json["error"]["code"] == "not_found"


class TestBoardsAndMembers:
    async def test_create_board_returns_tokens_once(self, api: Api):
        res = await api.call("POST", "/v1/boards", body={"name": "  my team "})
        assert res.status == 201
        assert res.json["board"]["name"] == "my team"
        assert res.json["join_token"].startswith("inv_") and len(res.json["join_token"]) == 47
        assert res.json["read_token"].startswith("rd_") and len(res.json["read_token"]) == 46
        assert res.json["join_url"] == f"http://test.local/join/{res.json['join_token']}"

    async def test_a_board_name_is_kept_on_one_line(self, api: Api):
        # The name is printed in listings and opens every agent's session context.
        res = await api.call("POST", "/v1/boards", body={"name": "my\nteam\t\r\n now"})
        assert res.status == 201
        assert res.json["board"]["name"] == "my team now"

    @pytest.mark.parametrize("name", ["\u001f", " \u001c\u001d ", "\u2028", "\u202e"])
    async def test_a_name_of_nothing_readable_is_refused(self, api: Api, name: str):
        # Characters that a one-line name drops leave nothing: 422, not a stored empty name.
        res = await api.call("POST", "/v1/boards", body={"name": name})
        assert res.status == 422

    async def test_rejects_a_board_without_a_name(self, api: Api):
        res = await api.call("POST", "/v1/boards", body={"name": " "})
        assert res.status == 422
        assert res.json["error"]["code"] == "validation_failed"

    async def test_stores_only_hashes_of_keys(self, api: Api):
        team = await new_team(api)
        assert team.claude.startswith("aw_")
        rows = await api.sql(
            """select count(*)::int as n from api_keys k
                 join members m on m.id = k.member_id where m.board_id = %s""",
            (team.board_id,),
        )
        assert rows[0]["n"] == 4
        leaked = await api.sql(
            "select 1 from api_keys where encode(key_hash, 'escape') like 'aw_%'"
        )
        assert leaked == []

    async def test_rejects_bad_expired_and_wrong_scope_join_tokens(self, api: Api):
        def body(token: str):
            return {
                "join_token": token,
                "owner": "eve",
                "members": [{"handle": "eve", "kind": "human"}],
            }

        assert (await api.call("POST", "/v1/boards/join", body=body("inv_nope"))).status == 401

        team = await new_team(api)
        await api.sql(
            """update board_tokens
                  set created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'
                where board_id = %s and scope = 'join'""",
            (team.board_id,),
        )
        assert (await api.call("POST", "/v1/boards/join", body=body(team.join_token))).status == 401

        other = await new_team(api)  # a read token cannot be used to join
        assert (
            await api.call("POST", "/v1/boards/join", body=body(other.read_token))
        ).status == 401

    async def test_rejects_duplicate_and_invalid_handles(self, api: Api):
        team = await new_team(api)

        async def join(owner: str, handle: str, kind: str):
            return await api.call(
                "POST",
                "/v1/boards/join",
                body={
                    "join_token": team.join_token,
                    "owner": owner,
                    "members": [{"handle": handle, "kind": kind}],
                },
            )

        assert (await join("alice", "alice", "human")).status == 409
        assert (await join("bob", "alice/other", "agent")).status == 422  # wrong owner prefix
        assert (await join("Zed", "Zed", "human")).status == 422
        assert (await join("all", "all", "human")).status == 422

    async def test_a_conflict_leaves_no_half_registered_members(self, api: Api):
        team = await new_team(api)
        res = await api.call(
            "POST",
            "/v1/boards/join",
            body={
                "join_token": team.join_token,
                "owner": "alice",
                "members": [
                    {"handle": "alice/gemini", "kind": "agent"},
                    {"handle": "alice", "kind": "human"},  # already exists
                ],
            },
        )
        assert res.status == 409
        rows = await api.sql(
            "select 1 from members where board_id = %s and handle = 'alice/gemini'",
            (team.board_id,),
        )
        assert rows == []

    async def test_a_person_adds_more_agents(self, api: Api):
        team = await new_team(api)
        res = await api.call("POST", "/v1/agents", key=team.alice, body={"name": "codex"})
        assert res.status == 201, res.json
        assert res.json["handle"] == "alice/codex" and res.json["kind"] == "agent"
        assert res.json["api_key"].startswith("aw_")

        me = await api.call("GET", "/v1/me", key=res.json["api_key"])
        assert me.json["member"]["handle"] == "alice/codex"
        assert me.json["member"]["owner"] == "alice"
        assert me.json["board"]["id"] == team.board_id

        # Each agent gets only its own mentions.
        await post(api, team.bob, "@alice/codex ping")
        codex_inbox = await api.call("GET", "/v1/inbox", key=res.json["api_key"])
        claude_inbox = await api.call("GET", "/v1/inbox", key=team.claude)
        assert [m["body"] for m in codex_inbox.json["messages"]] == ["@alice/codex ping"]
        assert claude_inbox.json["messages"] == []

    async def test_only_people_add_agents_and_names_are_checked(self, api: Api):
        team = await new_team(api)
        by_agent = await api.call("POST", "/v1/agents", key=team.claude, body={"name": "x"})
        assert by_agent.status == 403
        assert (
            await api.call("POST", "/v1/agents", key=team.alice, body={"name": "claude"})
        ).status == 409
        for bad in ("Codex", "a/b", "", "-x"):
            res = await api.call("POST", "/v1/agents", key=team.alice, body={"name": bad})
            assert res.status == 422, bad
        assert (await api.call("POST", "/v1/agents", body={"name": "codex"})).status == 401

    async def test_limits_agents_per_person(self, api: Api):
        team = await new_team(api)
        for n in range(2, 9):  # alice/claude exists, so seven more reach the limit of eight
            res = await api.call("POST", "/v1/agents", key=team.alice, body={"name": f"a{n}"})
            assert res.status == 201, res.json
        over = await api.call("POST", "/v1/agents", key=team.alice, body={"name": "a9"})
        assert over.status == 409
        assert "8 agents" in over.json["error"]["message"]

    async def test_requires_a_valid_api_key(self, api: Api):
        assert (await api.call("GET", "/v1/me")).status == 401
        assert (await api.call("GET", "/v1/me", key="aw_wrong")).status == 401
        assert (await api.call("GET", "/v1/messages")).status == 401

    async def test_me_members_and_presence(self, api: Api):
        team = await new_team(api)
        me = await api.call("GET", "/v1/me", key=team.codex)
        assert me.json["member"] == {
            "id": me.json["member"]["id"],
            "handle": "bob/codex",
            "kind": "agent",
            "owner": "bob",
            "status_text": None,
            "role": "member",
            "state": "active",
            "display_name": None,
            "title": None,
            "timezone": None,
        }
        assert me.json["board"]["id"] == team.board_id

        res = await api.call("PUT", "/v1/me/status", key=team.codex, body={"text": "wiring /users"})
        assert res.status == 204
        members = await api.call("GET", "/v1/members", key=team.claude)
        assert [m["handle"] for m in members.json["members"]] == [
            "alice",
            "alice/claude",
            "bob",
            "bob/codex",
        ]
        codex = next(m for m in members.json["members"] if m["handle"] == "bob/codex")
        assert codex["status_text"] == "wiring /users" and codex["online"] is True

        # A status is shown on one line, so it is kept as one.
        await api.call(
            "PUT",
            "/v1/me/status",
            key=team.codex,
            body={"text": " wiring\n● mallory  human\t now "},
        )
        members = await api.call("GET", "/v1/members", key=team.claude)
        codex = next(m for m in members.json["members"] if m["handle"] == "bob/codex")
        assert codex["status_text"] == "wiring ● mallory human now"

        await api.call("PUT", "/v1/me/status", key=team.codex, body={"text": ""})
        cleared = await api.call("GET", "/v1/me", key=team.codex)
        assert cleared.json["member"]["status_text"] is None

    async def test_only_shows_my_own_board(self, api: Api):
        a, b = await new_team(api, "a"), await new_team(api, "b")
        assert len((await api.call("GET", "/v1/members", key=a.alice)).json["members"]) == 4
        assert (await api.call("GET", "/v1/messages", key=b.alice)).json["messages"] == []

    async def test_issues_extra_join_tokens(self, api: Api):
        team = await new_team(api)
        issued = await api.call(
            "POST",
            "/v1/tokens",
            key=team.alice,
            body={"scope": "join", "label": "for carol", "expires_in_hours": 24},
        )
        assert issued.status == 201
        assert issued.json["url"] == f"http://test.local/join/{issued.json['token']}"

        joined = await api.call(
            "POST",
            "/v1/boards/join",
            body={
                "join_token": issued.json["token"],
                "owner": "carol",
                "members": [{"handle": "carol", "kind": "human"}],
            },
        )
        assert joined.status == 201
        assert joined.json["board"]["id"] == team.board_id


class TestReadReceipts:
    async def history(self, api: Api, key: str) -> list[dict]:
        return (await api.call("GET", "/v1/messages", key=key)).json["messages"]

    async def test_lists_recipients_and_who_has_seen_the_message(self, api: Api):
        team = await new_team(api)
        sent = await post(api, team.claude, "@bob/codex @bob ready")
        assert sent.json["message"]["recipients"] == ["bob", "bob/codex"]
        assert sent.json["message"]["seen_by"] == []

        await api.call("GET", "/v1/inbox", key=team.codex)
        [message] = await self.history(api, team.alice)
        assert message["recipients"] == ["bob", "bob/codex"]
        assert message["seen_by"] == ["bob/codex"]

    async def test_peeking_is_not_seeing(self, api: Api):
        team = await new_team(api)
        await post(api, team.claude, "@bob/codex hi")
        await api.call("GET", "/v1/inbox?ack=false", key=team.codex)
        assert (await self.history(api, team.alice))[0]["seen_by"] == []
        await api.call("POST", "/v1/inbox/ack", key=team.codex, body={"up_to": 1})
        assert (await self.history(api, team.alice))[0]["seen_by"] == ["bob/codex"]

    async def test_everyone_addressed_by_all_and_replies(self, api: Api):
        team = await new_team(api)
        await post(api, team.claude, "@all standup")
        reply = await post(api, team.bob, "on my way", reply_to=1)
        assert reply.json["message"]["recipients"] == ["alice/claude"]
        first = (await self.history(api, team.bob))[0]
        assert first["recipients"] == ["alice", "bob", "bob/codex"]

    async def test_members_show_how_far_they_have_read(self, api: Api):
        team = await new_team(api)
        await post(api, team.claude, "@bob/codex one")
        await post(api, team.claude, "@bob/codex two")
        await api.call("GET", "/v1/inbox?limit=1", key=team.codex)
        members = (await api.call("GET", "/v1/members", key=team.alice)).json["members"]
        cursor = {m["handle"]: m["read_up_to"] for m in members}
        assert cursor == {"alice": 0, "alice/claude": 0, "bob": 0, "bob/codex": 1}


class TestJoinEvents:
    async def activity(self, api: Api, key: str) -> list[tuple[str, str]]:
        history = (await api.call("GET", "/v1/messages", key=key)).json["messages"]
        return [(m["from"], m["body"]) for m in history if m["kind"] == "activity"]

    async def test_says_who_created_the_board_and_who_joined(self, api: Api):
        team = await new_team(api, keep_join_events=True)
        assert await self.activity(api, team.bob) == [
            ("alice", "alice created the board and joined with the agent alice/claude."),
            (
                "bob",
                "bob joined with the agent bob/codex through the invite created with the board.",
            ),
        ]

    async def test_events_reach_no_inbox(self, api: Api):
        team = await new_team(api, keep_join_events=True)
        for key in (team.alice, team.claude, team.bob, team.codex):
            assert (await api.call("GET", "/v1/inbox", key=key)).json["messages"] == []

    async def test_names_whose_invite_was_used_and_a_taken_name(self, api: Api):
        team = await new_team(api)
        issued = await api.call(
            "POST", "/v1/tokens", key=team.bob, body={"scope": "join", "label": "for carol"}
        )
        joined = await api.call(
            "POST",
            "/v1/boards/join",
            body={
                "join_token": issued.json["token"],
                "owner": "carol-2",
                "wanted_owner": "carol",
                "members": [
                    {"handle": "carol-2", "kind": "human"},
                    {"handle": "carol-2/claude", "kind": "agent"},
                    {"handle": "carol-2/codex", "kind": "agent"},
                ],
            },
        )
        assert joined.status == 201, joined.json
        # Bob's invite needs the owner's approval: carol-2 asks, and alice is told.
        assert joined.json["state"] == "pending"
        assert await self.activity(api, team.alice) == [
            (
                "carol-2",
                "carol-2 asks to join with the agents carol-2/claude and carol-2/codex"
                ' through the invite "for carol" from bob (the name "carol" was taken).'
                " Only alice can let them in, in a terminal: hailboard accept carol-2"
                " (or: hailboard decline carol-2).",
            )
        ]

    async def test_an_added_agent_is_announced(self, api: Api):
        team = await new_team(api)
        added = await api.call("POST", "/v1/agents", key=team.alice, body={"name": "codex"})
        assert added.status == 201
        assert await self.activity(api, team.bob) == [
            ("alice", "alice added the agent alice/codex.")
        ]

    async def test_a_failed_join_posts_nothing(self, api: Api):
        team = await new_team(api)
        res = await api.call(
            "POST",
            "/v1/boards/join",
            body={
                "join_token": team.join_token,
                "owner": "alice",
                "members": [{"handle": "alice", "kind": "human"}],
            },
        )
        assert res.status == 409
        assert await self.activity(api, team.bob) == []

    async def test_members_have_a_join_time(self, api: Api):
        team = await new_team(api)
        members = (await api.call("GET", "/v1/members", key=team.bob)).json["members"]
        assert all(m["joined_at"] for m in members)
        alice = next(m for m in members if m["handle"] == "alice")
        bob = next(m for m in members if m["handle"] == "bob")
        assert alice["joined_at"] <= bob["joined_at"]

    async def test_rejects_an_invalid_wanted_name(self, api: Api):
        team = await new_team(api)
        res = await api.call(
            "POST",
            "/v1/boards/join",
            body={
                "join_token": team.join_token,
                "owner": "dan",
                "wanted_owner": "Dan Smith",
                "members": [{"handle": "dan", "kind": "human"}],
            },
        )
        assert res.status == 422


class TestInviteInfo:
    async def test_names_the_board_without_using_the_invite(self, api: Api):
        team = await new_team(api)
        res = await api.call("GET", f"/v1/invite?token={team.join_token}")
        assert res.status == 200
        expires_at = res.json.pop("expires_at")
        assert res.json == {
            "board": {"id": team.board_id, "name": "team"},
            "label": None,
            "requires_approval": False,
        }
        # The board's first invite ends after a week, like any other.
        left = datetime.fromisoformat(expires_at) - datetime.now(UTC)
        assert timedelta(days=6, hours=23) < left <= timedelta(days=7)
        # Looking it up does not use it: it still works for joining.
        again = await api.call("GET", f"/v1/invite?token={team.join_token}")
        assert again.status == 200

    async def test_shows_the_label_and_expiry_of_an_extra_invite(self, api: Api):
        team = await new_team(api)
        issued = await api.call(
            "POST",
            "/v1/tokens",
            key=team.alice,
            body={"scope": "join", "label": " for\ncarol ", "expires_in_hours": 24},
        )
        res = await api.call("GET", f"/v1/invite?token={issued.json['token']}")
        assert res.json["label"] == "for carol"
        assert res.json["expires_at"] is not None

    async def test_rejects_unknown_expired_and_read_tokens(self, api: Api):
        assert (await api.call("GET", "/v1/invite?token=inv_nope")).status == 401
        assert (await api.call("GET", "/v1/invite")).status == 422

        team = await new_team(api)
        await api.sql(
            """update board_tokens
                  set created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'
                where board_id = %s and scope = 'join'""",
            (team.board_id,),
        )
        assert (await api.call("GET", f"/v1/invite?token={team.join_token}")).status == 401

        other = await new_team(api)
        assert (await api.call("GET", f"/v1/invite?token={other.read_token}")).status == 401


class TestMessagesAndInbox:
    async def test_a_mention_reaches_only_the_addressee_once(self, api: Api):
        team = await new_team(api)
        sent = await post(api, team.claude, "@bob/codex /users is ready")
        assert sent.status == 201
        message = sent.json["message"]
        assert (message["seq"], message["from"], message["mentions"]) == (
            1,
            "alice/claude",
            ["bob/codex"],
        )
        assert (message["kind"], message["reply_to"]) == ("message", None)
        assert sent.json["unknown_mentions"] == []

        inbox = await api.call("GET", "/v1/inbox", key=team.codex)
        assert len(inbox.json["messages"]) == 1
        assert inbox.json["messages"][0]["reason"] == "mention"
        assert inbox.json["messages"][0]["from"] == "alice/claude"
        assert inbox.json["remaining"] == 0

        assert (await api.call("GET", "/v1/inbox", key=team.codex)).json[
            "messages"
        ] == []  # cursor moved
        assert (await api.call("GET", "/v1/inbox", key=team.bob)).json["messages"] == []
        assert (await api.call("GET", "/v1/inbox", key=team.claude)).json["messages"] == []

    async def test_messages_without_mentions_only_appear_in_history(self, api: Api):
        team = await new_team(api)
        await post(api, team.claude, "thinking out loud")
        for key in (team.alice, team.bob, team.codex):
            assert (await api.call("GET", "/v1/inbox", key=key)).json["messages"] == []
        history = await api.call("GET", "/v1/messages", key=team.bob)
        assert [m["body"] for m in history.json["messages"]] == ["thinking out loud"]

    async def test_ignores_a_mention_of_yourself(self, api: Api):
        team = await new_team(api)
        sent = await post(api, team.claude, "note to @alice/claude")
        assert sent.json["message"]["mentions"] == []
        assert (await api.call("GET", "/v1/inbox", key=team.claude)).json["messages"] == []

    async def test_reports_unknown_mentions_instead_of_failing(self, api: Api):
        team = await new_team(api)
        sent = await post(api, team.claude, "bump @types/node and ask @nobody/here, cc @bob/codex")
        assert sent.status == 201
        assert sorted(sent.json["unknown_mentions"]) == ["nobody/here", "types/node"]
        assert sent.json["message"]["mentions"] == ["bob/codex"]

    async def test_all_goes_to_everyone_else_and_human_to_humans_only(self, api: Api):
        team = await new_team(api)
        await post(api, team.claude, "@all standup")
        await post(api, team.claude, "@human please decide")

        async def reasons(key: str):
            res = await api.call("GET", "/v1/inbox", key=key)
            return [f"{m['seq']}:{m['reason']}" for m in res.json["messages"]]

        assert await reasons(team.codex) == ["1:all"]
        assert await reasons(team.bob) == ["1:all", "2:human"]
        assert await reasons(team.alice) == ["1:all", "2:human"]
        assert await reasons(team.claude) == []  # the author

    async def test_a_human_request_is_addressed_to_all_humans(self, api: Api):
        team = await new_team(api)
        sent = await post(api, team.codex, "deploy to prod or staging?", kind="human_request")
        assert sent.json["message"]["kind"] == "human_request"
        assert sent.json["message"]["mention_humans"] is True
        alice = await api.call("GET", "/v1/inbox", key=team.alice)
        assert alice.json["messages"][0]["reason"] == "human"
        assert alice.json["messages"][0]["kind"] == "human_request"
        assert (await api.call("GET", "/v1/inbox", key=team.claude)).json["messages"] == []

    async def test_the_author_of_the_replied_message_is_notified(self, api: Api):
        team = await new_team(api)
        await post(api, team.claude, "@bob/codex add GET /users")
        reply = await post(api, team.codex, "done, see commit abc", reply_to=1)
        assert reply.json["message"]["reply_to"] == 1

        inbox = await api.call("GET", "/v1/inbox", key=team.claude)
        assert len(inbox.json["messages"]) == 1
        got = inbox.json["messages"][0]
        assert (got["seq"], got["reason"], got["reply_to"]) == (2, "reply", 1)

    async def test_a_mention_wins_over_a_reply_for_the_same_person(self, api: Api):
        team = await new_team(api)
        await post(api, team.claude, "first")
        await post(api, team.codex, "@alice/claude re: first", reply_to=1)
        inbox = await api.call("GET", "/v1/inbox", key=team.claude)
        assert [m["reason"] for m in inbox.json["messages"]] == ["mention"]

    async def test_validates_messages(self, api: Api):
        team = await new_team(api)

        async def send(body):
            return await api.call("POST", "/v1/messages", key=team.claude, body=body)

        assert (await send({"body": ""})).status == 422
        assert (await send({"body": "   "})).status == 422
        assert (await send({"body": "x" * 8001})).status == 422
        assert (await send({"body": "ok", "kind": "activity"})).status == 422
        assert (await send({"body": "ok", "reply_to": 99})).status == 422
        assert (await send({})).status == 422
        assert (await send({"body": "x" * 8000})).status == 201

        raw = await api.call("POST", "/v1/messages", key=team.claude)  # no body at all
        assert raw.status == 422
        assert "JSON" in raw.json["error"]["message"]

    async def test_cannot_reply_to_a_message_of_another_board(self, api: Api):
        a, b = await new_team(api, "a"), await new_team(api, "b")
        await post(api, a.claude, "hello")
        await post(api, b.claude, "hello")
        # seq 1 exists on both boards, seq 2 on neither
        assert (await post(api, b.claude, "x", reply_to=2)).status == 422

    async def test_pages_the_history(self, api: Api):
        team = await new_team(api)
        for i in range(1, 6):
            await post(api, team.claude, f"m{i}")

        def bodies(res):
            return [m["body"] for m in res.json["messages"]]

        latest = await api.call("GET", "/v1/messages?limit=2", key=team.bob)
        assert bodies(latest) == ["m4", "m5"] and latest.json["next_after"] == 5

        first = await api.call("GET", "/v1/messages?after=0&limit=2", key=team.bob)
        assert bodies(first) == ["m1", "m2"] and first.json["next_after"] == 2

        rest = await api.call("GET", f"/v1/messages?after={first.json['next_after']}", key=team.bob)
        assert bodies(rest) == ["m3", "m4", "m5"]

        none = await api.call("GET", "/v1/messages?after=5", key=team.bob)
        assert none.json == {"messages": [], "next_after": 5}

        assert (await api.call("GET", "/v1/messages?limit=101", key=team.bob)).status == 422

    async def test_pages_the_inbox_and_reports_what_is_left(self, api: Api):
        team = await new_team(api)
        for i in range(1, 6):
            await post(api, team.claude, f"@bob/codex n{i}")
        page1 = await api.call("GET", "/v1/inbox?limit=2", key=team.codex)
        assert seqs(page1) == [1, 2] and page1.json["remaining"] == 3
        page2 = await api.call("GET", "/v1/inbox?limit=10", key=team.codex)
        assert seqs(page2) == [3, 4, 5] and page2.json["remaining"] == 0

    async def test_reads_without_acknowledging_and_acknowledges_later(self, api: Api):
        team = await new_team(api)
        for i in range(1, 4):
            await post(api, team.claude, f"@bob/codex n{i}")
        peek = await api.call("GET", "/v1/inbox?ack=false", key=team.codex)
        assert len(peek.json["messages"]) == 3
        again = await api.call("GET", "/v1/inbox?ack=false", key=team.codex)
        assert len(again.json["messages"]) == 3  # not acknowledged: still there

        ack = await api.call("POST", "/v1/inbox/ack", key=team.codex, body={"up_to": 2})
        assert ack.status == 204
        left = await api.call("GET", "/v1/inbox", key=team.codex)
        assert seqs(left) == [3]

        # The cursor never moves backwards and never past the last message on the board.
        await api.call("POST", "/v1/inbox/ack", key=team.codex, body={"up_to": 1})
        await api.call("POST", "/v1/inbox/ack", key=team.codex, body={"up_to": 9999})
        rows = await api.sql(
            "select inbox_cursor from members where board_id = %s and handle = 'bob/codex'",
            (team.board_id,),
        )
        assert rows[0]["inbox_cursor"] == 3
        bad = await api.call("POST", "/v1/inbox/ack", key=team.codex, body={"up_to": -1})
        assert bad.status == 422

    async def test_all_sent_before_joining_is_not_shown(self, api: Api):
        team = await new_team(api)
        await post(api, team.claude, "@all welcome")
        joined = await api.call(
            "POST",
            "/v1/boards/join",
            body={
                "join_token": team.join_token,
                "owner": "late",
                "members": [{"handle": "late", "kind": "human"}],
            },
        )
        key = joined.json["members"][0]["api_key"]
        assert (await api.call("GET", "/v1/inbox", key=key)).json["messages"] == []
        history = (await api.call("GET", "/v1/messages", key=key)).json["messages"]
        assert [m["kind"] for m in history] == ["message", "activity"]  # then their join event

    async def test_numbers_concurrent_messages_without_gaps(self, api: Api):
        team = await new_team(api)
        results = await asyncio.gather(
            *(post(api, team.claude, f"@bob/codex #{i}") for i in range(25))
        )
        assert all(r.status == 201 for r in results)
        assert sorted(r.json["message"]["seq"] for r in results) == list(range(1, 26))
        inbox = await api.call("GET", "/v1/inbox?limit=100", key=team.codex)
        assert len(inbox.json["messages"]) == 25

    async def test_concurrent_readers_never_get_the_same_message(self, api: Api):
        team = await new_team(api)
        for i in range(10):
            await post(api, team.claude, f"@bob/codex {i}")
        reads = await asyncio.gather(
            *(api.call("GET", "/v1/inbox?limit=3", key=team.codex) for _ in range(5))
        )
        got = [m["seq"] for r in reads for m in r.json["messages"]]
        assert len(set(got)) == len(got)
