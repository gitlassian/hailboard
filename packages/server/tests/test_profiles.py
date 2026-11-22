"""Profiles: the name a person goes by, their title and time zone, and their machines."""

import json

from conftest import Api, new_team


async def profile(api: Api, key: str, body: dict):
    return await api.call("PATCH", "/v1/me/profile", key=key, body=body)


def by_handle(members: list[dict]) -> dict[str, dict]:
    return {m["handle"]: m for m in members}


async def test_a_person_sets_their_profile_and_others_see_it(api: Api):
    team = await new_team(api, "profiles")
    body = {"display_name": " Alice Smith ", "title": "frontend", "timezone": "Europe/Kyiv"}
    assert (await profile(api, team.alice, body)).status == 204

    listed = by_handle((await api.call("GET", "/v1/members", key=team.bob)).json["members"])
    alice = listed["alice"]
    assert (alice["display_name"], alice["title"], alice["timezone"]) == (
        "Alice Smith",
        "frontend",
        "Europe/Kyiv",
    )
    assert listed["alice/claude"]["display_name"] is None
    assert listed["bob"]["timezone"] is None

    me = (await api.call("GET", "/v1/me", key=team.alice)).json["member"]
    assert me["title"] == "frontend"

    # A field left out stays; null clears it.
    assert (await profile(api, team.alice, {"title": None})).status == 204
    alice = by_handle((await api.call("GET", "/v1/members", key=team.bob)).json["members"])["alice"]
    assert (alice["display_name"], alice["title"]) == ("Alice Smith", None)


async def test_profile_values_are_checked(api: Api):
    team = await new_team(api, "profiles-checked")
    assert (await profile(api, team.alice, {"timezone": "Mars/Olympus"})).status == 422
    assert (await profile(api, team.alice, {"timezone": "../../etc/passwd"})).status == 422
    assert (await profile(api, team.alice, {"title": "x" * 41})).status == 422
    assert (await profile(api, team.alice, {"display_name": "   "})).status == 422
    # Line breaks become spaces, as in a status.
    assert (await profile(api, team.alice, {"display_name": "Alice\nSmith"})).status == 204
    me = (await api.call("GET", "/v1/me", key=team.alice)).json["member"]
    assert me["display_name"] == "Alice Smith"
    # An agent has no profile: it shows what it does with its status.
    assert (await profile(api, team.claude, {"title": "bot"})).status == 403


async def test_machines_are_listed_for_members_but_not_on_the_feed(api: Api):
    team = await new_team(api, "profiles-machines")
    listed = by_handle((await api.call("GET", "/v1/members", key=team.bob)).json["members"])
    assert listed["alice"]["machines"] == []

    made = await api.call("POST", "/v1/me/devices", key=team.alice, body={"device": "desktop"})
    joined = await api.call(
        "POST", "/v1/devices/redeem", body={"code": made.json["code"], "device": "laptop"}
    )
    keys = {m["handle"]: m["api_key"] for m in joined.json["members"]}
    # The agent last worked from the laptop.
    await api.call("GET", "/v1/me", key=keys["alice/claude"])

    listed = by_handle((await api.call("GET", "/v1/members", key=team.bob)).json["members"])
    assert set(listed["alice"]["machines"]) == {"desktop", "laptop"}
    assert listed["alice/claude"]["machines"][0] == "laptop"

    feed = await api.call("GET", f"/v1/feed/members?token={team.read_token}")
    assert all(m["machines"] == [] for m in feed.json["members"])


async def test_old_zone_names_are_accepted_and_the_servers_own_is_not(api: Api):
    team = await new_team(api, "profiles-aliases")
    # Node reports the old names: Europe/Kiev for Kyiv, Asia/Calcutta for India.
    for zone in ("Europe/Kiev", "Asia/Calcutta", "US/Eastern"):
        assert (await profile(api, team.alice, {"timezone": zone})).status == 204, zone
    for zone in ("localtime", "Factory"):
        assert (await profile(api, team.alice, {"timezone": zone})).status == 422, zone


async def test_a_joining_machine_gives_the_person_its_time_zone(api: Api):
    board = await api.call("POST", "/v1/boards", body={"name": "profiles-join"})

    async def join(owner: str, timezone: str):
        res = await api.call(
            "POST",
            "/v1/boards/join",
            body={
                "join_token": board.json["join_token"],
                "owner": owner,
                "members": [
                    {"handle": owner, "kind": "human"},
                    {"handle": f"{owner}/claude", "kind": "agent"},
                ],
                "timezone": timezone,
            },
        )
        assert res.status == 201, res.json
        return {m["handle"]: m["api_key"] for m in res.json["members"]}

    alice = await join("alice", "Europe/Kiev")
    # Bob waits for alice to let him in, and still has his time zone; a zone the server does not
    # know is dropped rather than failing the join.
    bob = await join("bob", "Asia/Calcutta")
    carol = await join("carol", "Nowhere/Land")
    me = (await api.call("GET", "/v1/me", key=bob["bob"])).json["member"]
    assert (me["state"], me["timezone"]) == ("pending", "Asia/Calcutta")
    assert (await api.call("GET", "/v1/me", key=carol["carol"])).json["member"]["timezone"] is None

    listed = by_handle((await api.call("GET", "/v1/members", key=alice["alice"])).json["members"])
    assert listed["alice"]["timezone"] == "Europe/Kiev"
    assert listed["alice/claude"]["timezone"] is None


async def test_the_live_feed_leaves_machines_out(api: Api):
    from test_realtime import open_stream

    team = await new_team(api, "profiles-stream")
    made = await api.call("POST", "/v1/me/devices", key=team.alice, body={"device": "desktop"})
    await api.call("POST", "/v1/devices/redeem", body={"code": made.json["code"], "device": "pc"})

    async with open_stream(api, f"/v1/stream?token={team.read_token}") as (_, sse):
        await sse.until(lambda events: any(e.get("event") == "member" for e in events))
        members = [json.loads(e["data"]) for e in sse.of("member")]
    assert members
    assert all("machines" not in m for m in members)
