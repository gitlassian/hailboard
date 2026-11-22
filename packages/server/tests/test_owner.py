"""The board's owner: letting people in, taking them off, links that end, and the security log."""

import asyncio
import json
from datetime import UTC, datetime, timedelta

from conftest import Api, Team, new_team
from test_realtime import open_stream


async def join(api: Api, token: str, owner: str, *agents: str):
    members = [{"handle": owner, "kind": "human"}]
    members += [{"handle": f"{owner}/{a}", "kind": "agent"} for a in agents]
    return await api.call(
        "POST", "/v1/boards/join", body={"join_token": token, "owner": owner, "members": members}
    )


def keys(joined) -> dict[str, str]:
    return {m["handle"]: m["api_key"] for m in joined.json["members"]}


async def invite(api: Api, key: str, **body) -> str:
    made = await api.call("POST", "/v1/tokens", key=key, body={"scope": "join", **body})
    assert made.status == 201, made.json
    return made.json["token"]


async def handles(api: Api, key: str, query: str = "") -> dict[str, str]:
    listed = (await api.call("GET", f"/v1/members{query}", key=key)).json["members"]
    return {m["handle"]: m["state"] for m in listed}


async def carol_waits(api: Api, team: Team, owner: str = "alice") -> dict[str, str]:
    """Carol asks to join through an invite of bob's, which needs the owner's approval."""
    joined = await join(api, await invite(api, team.bob), "carol", "claude")
    assert joined.status == 201, joined.json
    assert (joined.json["state"], joined.json["board_owner"]) == ("pending", owner)
    return keys(joined)


class TestOwner:
    async def test_the_creator_owns_the_board(self, api: Api):
        team = await new_team(api)
        me = (await api.call("GET", "/v1/me", key=team.alice)).json
        assert (me["member"]["role"], me["board_owner"]) == ("owner", "alice")
        bob = (await api.call("GET", "/v1/me", key=team.bob)).json
        assert (bob["member"]["role"], bob["board_owner"]) == ("member", "alice")
        listed = (await api.call("GET", "/v1/members", key=team.bob)).json["members"]
        assert {m["handle"]: m["role"] for m in listed}["alice"] == "owner"

    async def test_the_owner_hands_the_board_over(self, api: Api):
        team = await new_team(api)
        refused = await api.call("PUT", "/v1/board/owner", key=team.bob, body={"handle": "bob"})
        assert refused.status == 403
        res = await api.call("PUT", "/v1/board/owner", key=team.alice, body={"handle": "bob"})
        assert res.status == 204
        assert (await api.call("GET", "/v1/me", key=team.bob)).json["member"]["role"] == "owner"
        # Alice is now like anyone else.
        await carol_waits(api, team, owner="bob")
        assert (await api.call("POST", "/v1/members/carol/accept", key=team.alice)).status == 403
        assert (await api.call("POST", "/v1/members/carol/accept", key=team.bob)).status == 204

    async def test_an_agent_cannot_act_as_the_owner(self, api: Api):
        team = await new_team(api)
        await carol_waits(api, team)
        res = await api.call("POST", "/v1/members/carol/accept", key=team.claude)
        assert res.status == 403


class TestApproval:
    async def test_a_newcomer_waits_and_the_owner_is_told(self, api: Api):
        team = await new_team(api)
        carol = await carol_waits(api, team)

        # Carol's keys say who she is and whom she waits for, and nothing else.
        me = await api.call("GET", "/v1/me", key=carol["carol/claude"])
        assert me.status == 200
        assert (me.json["member"]["state"], me.json["board_owner"]) == ("pending", "alice")
        inbox = await api.call("GET", "/v1/inbox", key=carol["carol"])
        assert inbox.status == 403
        assert inbox.json["error"]["code"] == "pending"
        assert "alice has not let you onto this board yet" in inbox.json["error"]["message"]

        # Alice and her agent hear of it; bob does not.
        for key in (team.alice, team.claude):
            got = (await api.call("GET", "/v1/inbox", key=key)).json["messages"]
            assert [m["body"].split(".")[0] for m in got] == [
                "carol asks to join with the agent carol/claude through an invite from bob"
            ]
        assert (await api.call("GET", "/v1/inbox", key=team.bob)).json["messages"] == []

        # Not a member yet: not listed, and @all does not reach her.
        assert "carol" not in await handles(api, team.bob)
        assert (await handles(api, team.alice, "?pending=true"))["carol"] == "pending"
        sent = await api.call("POST", "/v1/messages", key=team.bob, body={"body": "@all hi"})
        assert "carol" not in sent.json["message"]["recipients"]

    async def test_the_owner_lets_them_in(self, api: Api):
        team = await new_team(api)
        carol = await carol_waits(api, team)
        assert (await api.call("POST", "/v1/members/carol/accept", key=team.bob)).status == 403
        assert (await api.call("POST", "/v1/members/carol/accept", key=team.alice)).status == 204

        got = (await api.call("GET", "/v1/inbox", key=carol["carol/claude"])).json["messages"]
        assert [m["body"] for m in got] == ["alice let carol and carol/claude onto the board."]
        assert (await handles(api, team.bob))["carol/claude"] == "active"
        again = await api.call("POST", "/v1/members/carol/accept", key=team.alice)
        assert again.status == 404

    async def test_the_owner_turns_them_down(self, api: Api):
        team = await new_team(api)
        carol = await carol_waits(api, team)
        assert (await api.call("POST", "/v1/members/carol/decline", key=team.alice)).status == 204
        assert (await api.call("GET", "/v1/me", key=carol["carol"])).status == 401
        assert "carol" not in await handles(api, team.alice, "?pending=true")

    async def test_an_open_invite_needs_no_approval_and_only_the_owner_makes_one(self, api: Api):
        team = await new_team(api)
        refused = await api.call(
            "POST", "/v1/tokens", key=team.bob, body={"scope": "join", "open": True}
        )
        assert refused.status == 403
        joined = await join(api, await invite(api, team.alice, open=True), "carol")
        assert joined.json["state"] == "active"
        assert (await api.call("GET", "/v1/inbox", key=keys(joined)["carol"])).status == 200

    async def test_nobody_joins_a_board_without_an_owner(self, api: Api):
        team = await new_team(api)
        made = await invite(api, team.bob)
        await api.sql("update members set role = 'member' where board_id = %s", (team.board_id,))
        refused = await join(api, made, "carol")
        assert refused.status == 403
        assert "no owner" in refused.json["error"]["message"]

    async def test_a_new_board_starts_with_a_person(self, api: Api):
        board = await api.call("POST", "/v1/boards", body={"name": "agents only"})
        token = board.json["join_token"]
        body = {
            "join_token": token,
            "owner": "eve",
            "members": [{"handle": "eve/a", "kind": "agent"}],
        }
        refused = await api.call("POST", "/v1/boards/join", body=body)
        assert refused.status == 422
        # The refused join did not use the invite up or make anyone the owner.
        assert (await join(api, token, "carol")).json["board_owner"] == "carol"


class TestTakingOff:
    async def test_the_owner_takes_a_person_off_with_their_agents(self, api: Api):
        team = await new_team(api)
        await api.call("POST", "/v1/zones", key=team.codex, body={"paths": ["web"]})
        task = await api.call("POST", "/v1/tasks", key=team.codex, body={"title": "Cart"})
        number = task.json["number"]
        taken = await api.call("POST", f"/v1/tasks/{number}/take", key=team.codex)
        await api.call("POST", "/v1/messages", key=team.codex, body={"body": "@alice hello"})

        assert (await api.call("DELETE", "/v1/members/bob", key=team.claude)).status == 403
        assert (await api.call("DELETE", "/v1/members/bob", key=team.alice)).status == 204

        for key in (team.bob, team.codex):
            assert (await api.call("GET", "/v1/me", key=key)).status == 401
        assert set(await handles(api, team.alice)) == {"alice", "alice/claude"}
        zones = (await api.call("GET", "/v1/zones", key=team.alice)).json["zones"]
        assert zones == []
        tasks = (await api.call("GET", "/v1/tasks", key=team.alice)).json["tasks"]
        assert [t["agents"] for t in tasks] == [[]]
        assert taken.status == 200, taken.json
        history = (await api.call("GET", "/v1/messages", key=team.alice)).json["messages"]
        assert "@alice hello" in [m["body"] for m in history]
        assert history[-1]["body"] == "alice took bob and bob/codex off the board."

    async def test_the_owner_cannot_be_taken_off(self, api: Api):
        team = await new_team(api)
        res = await api.call("DELETE", "/v1/members/alice", key=team.alice)
        assert res.status == 403

    async def test_a_person_takes_off_their_own_agent(self, api: Api):
        team = await new_team(api)
        assert (await api.call("DELETE", "/v1/members/alice/claude", key=team.bob)).status == 403
        assert (await api.call("DELETE", "/v1/members/bob/codex", key=team.bob)).status == 204
        assert (await api.call("GET", "/v1/me", key=team.codex)).status == 401
        assert (await api.call("GET", "/v1/me", key=team.bob)).status == 200

    async def test_leaving_and_coming_back(self, api: Api):
        team = await new_team(api)
        assert (await api.call("POST", "/v1/me/leave", key=team.alice)).status == 403
        assert (await api.call("POST", "/v1/me/leave", key=team.codex)).status == 403
        assert (await api.call("POST", "/v1/me/leave", key=team.bob)).status == 204
        assert (await api.call("GET", "/v1/me", key=team.codex)).status == 401

        # The name stays bob's: whoever comes back joins under a new one, with nothing of his.
        made = await invite(api, team.alice, open=True)
        taken = await join(api, made, "bob", "codex")
        assert taken.status == 409
        back = await join(api, made, "bob-2", "codex")
        assert back.status == 201, back.json
        assert back.json["state"] == "active"
        assert (await api.call("GET", "/v1/inbox", key=keys(back)["bob-2/codex"])).status == 200

    async def test_nobody_takes_over_the_name_and_files_of_someone_who_left(self, api: Api):
        team = await new_team(api)
        sent = await api.client.post(
            "/v1/files",
            params={"name": "secret.txt", "to": "bob"},
            content=b"TOP SECRET",
            headers={"authorization": f"Bearer {team.alice}"},
        )
        assert sent.status_code == 201, sent.json()
        await api.call("POST", "/v1/me/leave", key=team.bob)
        squat = await join(api, await invite(api, team.alice, open=True), "bob")
        assert squat.status == 409

    async def test_a_stopped_key_says_so(self, api: Api):
        team = await new_team(api)
        await api.call("DELETE", "/v1/members/bob", key=team.alice)
        res = await api.call("GET", "/v1/inbox", key=team.codex)
        assert res.status == 401
        assert res.json["error"]["code"] == "removed"
        unknown = await api.call("GET", "/v1/inbox", key="ak_" + "x" * 43)
        assert unknown.json["error"]["code"] == "unauthorized"

    async def test_links_stop_with_whoever_made_them(self, api: Api):
        team = await new_team(api)
        feed = await api.call("POST", "/v1/tokens", key=team.codex, body={"scope": "read"})
        made = await invite(api, team.bob)
        read = feed.json["token"]
        assert (await api.call("GET", f"/v1/feed/messages?token={read}")).status == 200

        await api.call("DELETE", "/v1/members/bob", key=team.alice)
        assert (await api.call("GET", f"/v1/feed/messages?token={read}")).status == 401
        assert (await join(api, made, "carol")).status == 401
        links = (await api.call("GET", "/v1/tokens", key=team.alice)).json["tokens"]
        stopped = [t for t in links if t["created_by"] in ("bob", "bob/codex")]
        assert len(stopped) == 2 and not any(t["active"] for t in stopped)

    async def test_the_boards_first_links_are_the_creators(self, api: Api):
        team = await new_team(api)
        links = (await api.call("GET", "/v1/tokens", key=team.alice)).json["tokens"]
        first = [(t["scope"], t["created_by"], t["requires_approval"]) for t in links[:2]]
        # (new_team made the first invite need no approval; a feed link never does.)
        assert first == [("join", "alice", False), ("read", "alice", False)]
        # Handed over, alice leaves: the feed link she was given at the start stops too.
        await api.call("PUT", "/v1/board/owner", key=team.alice, body={"handle": "bob"})
        await api.call("POST", "/v1/me/leave", key=team.alice)
        res = await api.call("GET", f"/v1/feed/messages?token={team.read_token}")
        assert res.status == 401

    async def test_a_reply_to_someone_who_is_gone_reaches_nobody(self, api: Api):
        team = await new_team(api)
        asked = await api.call("POST", "/v1/messages", key=team.codex, body={"body": "a question"})
        await api.call("DELETE", "/v1/members/bob", key=team.alice)
        await api.call(
            "POST",
            "/v1/messages",
            key=team.alice,
            body={"body": "after", "reply_to": asked.json["message"]["seq"]},
        )
        rows = await api.sql(
            """select 1 from message_recipients r join members m on m.id = r.member_id
                where m.board_id = %s and m.owner = 'bob'""",
            (team.board_id,),
        )
        assert rows == []

    async def test_an_agent_that_was_taken_off_can_be_added_back(self, api: Api):
        team = await new_team(api)
        assert (await api.call("DELETE", "/v1/members/bob/codex", key=team.bob)).status == 204
        back = await api.call("POST", "/v1/agents", key=team.bob, body={"name": "codex"})
        assert back.status == 201, back.json
        assert (await api.call("GET", "/v1/me", key=back.json["api_key"])).status == 200
        assert (await api.call("GET", "/v1/me", key=team.codex)).status == 401


class TestRaces:
    async def test_two_hand_overs_at_once(self, api: Api):
        team = await new_team(api)
        await carol_waits(api, team)
        await api.call("POST", "/v1/members/carol/accept", key=team.alice)
        results = await asyncio.gather(
            api.call("PUT", "/v1/board/owner", key=team.alice, body={"handle": "bob"}),
            api.call("PUT", "/v1/board/owner", key=team.alice, body={"handle": "carol"}),
        )
        assert sorted(r.status for r in results) == [204, 403]
        owners = await api.sql(
            "select handle from members where board_id = %s and role = 'owner'", (team.board_id,)
        )
        assert len(owners) == 1


class TestLinks:
    async def test_a_new_boards_invite_needs_approval_and_its_feed_does_not(self, api: Api):
        board = await api.call("POST", "/v1/boards", body={"name": "fresh"})
        alice = keys(await join(api, board.json["join_token"], "alice"))["alice"]
        links = (await api.call("GET", "/v1/tokens", key=alice)).json["tokens"]
        assert [(t["scope"], t["requires_approval"]) for t in links] == [
            ("join", True),
            ("read", False),
        ]
        assert links[0]["expires_at"] is not None and links[1]["expires_at"] is None

    async def test_an_agent_cannot_stop_a_link(self, api: Api):
        team = await new_team(api)
        made = await api.call("POST", "/v1/tokens", key=team.codex, body={"scope": "read"})
        link = made.json["id"]
        assert (await api.call("DELETE", f"/v1/tokens/{link}", key=team.codex)).status == 403
        assert (await api.call("DELETE", f"/v1/tokens/{link}", key=team.bob)).status == 204

    async def test_an_invite_lasts_a_week_and_ends_after_its_uses(self, api: Api):
        team = await new_team(api)
        made = await api.call(
            "POST",
            "/v1/tokens",
            key=team.alice,
            body={"scope": "join", "open": True, "max_uses": 1},
        )
        expires = datetime.fromisoformat(made.json["expires_at"])
        assert timedelta(days=6, hours=23) < expires - datetime.now(UTC) <= timedelta(days=7)
        assert (await join(api, made.json["token"], "carol")).status == 201
        used_up = await join(api, made.json["token"], "dan")
        assert used_up.status == 401
        assert "used up" in used_up.json["error"]["message"]
        feed = await api.call("POST", "/v1/tokens", key=team.alice, body={"scope": "read"})
        assert feed.json["expires_at"] is None

    async def test_listing_shows_the_owner_every_link_and_others_their_own(self, api: Api):
        team = await new_team(api)
        await invite(api, team.codex, label="from bob's agent")
        await invite(api, team.claude, label="from alice's agent")
        everything = (await api.call("GET", "/v1/tokens", key=team.alice)).json["tokens"]
        assert len(everything) == 4  # the board's initial invite and feed, and the two new ones
        mine = (await api.call("GET", "/v1/tokens", key=team.bob)).json["tokens"]
        assert [(t["label"], t["created_by"], t["active"]) for t in mine] == [
            ("from bob's agent", "bob/codex", True)
        ]
        assert "token" not in mine[0]

    async def test_revoking_a_link(self, api: Api):
        team = await new_team(api)
        made = await api.call("POST", "/v1/tokens", key=team.alice, body={"scope": "join"})
        link = made.json["id"]
        assert (await api.call("DELETE", f"/v1/tokens/{link}", key=team.bob)).status == 403
        assert (await api.call("DELETE", f"/v1/tokens/{link}", key=team.alice)).status == 204
        assert (await join(api, made.json["token"], "carol")).status == 401
        assert (await api.call("DELETE", "/v1/tokens/tok_nope", key=team.alice)).status == 404

    async def test_a_revoked_feed_link_closes_an_open_page(self, api: Api):
        team = await new_team(api)
        async with open_stream(api, f"/v1/stream?token={team.read_token}") as (_, sse):
            await sse.until(lambda e: any(x.get("event") == "member" for x in e))
            tokens = (await api.call("GET", "/v1/tokens", key=team.alice)).json["tokens"]
            feed = next(t["id"] for t in tokens if t["scope"] == "read")
            await api.call("DELETE", f"/v1/tokens/{feed}", key=team.alice)
            # A new message wakes the stream; it finds the link revoked.
            await api.call("POST", "/v1/messages", key=team.bob, body={"body": "after"})
            await sse.until(lambda e: any(x.get("event") == "revoked" for x in e))
            assert json.loads(sse.of("revoked")[0]["data"]) == {}


class TestSecurityLog:
    async def test_the_owner_reads_what_happened(self, api: Api):
        team = await new_team(api)
        await carol_waits(api, team)
        await api.call("POST", "/v1/members/carol/accept", key=team.alice)
        await api.call("DELETE", "/v1/members/carol", key=team.alice)

        assert (await api.call("GET", "/v1/audit", key=team.bob)).status == 403
        events = (await api.call("GET", "/v1/audit", key=team.alice)).json["events"]
        assert [(e["kind"], e["actor"], e["subject"]) for e in events[:4]] == [
            ("member_removed", "alice", "carol"),
            ("member_accepted", "alice", "carol"),
            ("member_requested", "carol", "carol"),
            ("link_created", "bob", events[3]["subject"]),
        ]
