"""One person on several machines: one-time codes, keys per machine, taking a machine off."""

from conftest import Api, new_team


async def code_for(api: Api, key: str, device: str | None = None) -> str:
    body = {} if device is None else {"device": device}
    made = await api.call("POST", "/v1/me/devices", key=key, body=body)
    assert made.status == 201, made.json
    assert made.json["url"] == f"http://test.local/device/{made.json['code']}"
    return made.json["code"]


async def redeem(api: Api, code: str, device: str = "laptop"):
    return await api.call("POST", "/v1/devices/redeem", body={"code": code, "device": device})


async def test_a_second_machine_is_the_same_person(api: Api):
    team = await new_team(api, "devices")
    joined = await redeem(api, await code_for(api, team.alice, device="desktop"))
    assert joined.status == 201, joined.json
    assert joined.json["owner"] == "alice"
    assert joined.json["device"] == "laptop"
    keys = {m["handle"]: m["api_key"] for m in joined.json["members"]}
    assert set(keys) == {"alice", "alice/claude"}

    # New keys, for the same members: no alice-2, nobody waits for the owner.
    me = await api.call("GET", "/v1/me", key=keys["alice"])
    assert (me.json["member"]["handle"], me.json["member"]["state"]) == ("alice", "active")
    posted = await api.call("POST", "/v1/messages", key=keys["alice/claude"], body={"body": "hi"})
    assert posted.status == 201, posted.json
    assert posted.json["message"]["from"] == "alice/claude"
    listed = (await api.call("GET", "/v1/members", key=team.bob)).json["members"]
    assert sorted(m["handle"] for m in listed) == ["alice", "alice/claude", "bob", "bob/codex"]

    devices = (await api.call("GET", "/v1/me/devices", key=keys["alice"])).json["devices"]
    assert [(d["name"], d["current"]) for d in devices] == [("desktop", False), ("laptop", True)]

    log = (await api.call("GET", "/v1/audit", key=team.alice)).json["events"]
    assert [e["kind"] for e in log[:2]] == ["device_added", "device_code"]


async def test_a_code_works_once_and_only_for_a_person(api: Api):
    team = await new_team(api, "devices-once")
    code = await code_for(api, team.alice)
    assert (await redeem(api, code)).status == 201
    again = await redeem(api, code, device="phone")
    assert again.status == 401
    assert "does not work" in again.json["error"]["message"]
    assert (await redeem(api, "dev_nothing")).status == 401

    agent = await api.call("POST", "/v1/me/devices", key=team.claude, body={})
    assert agent.status == 403


async def test_an_ended_code_and_a_name_in_use(api: Api):
    team = await new_team(api, "devices-ended")
    code = await code_for(api, team.alice)
    await api.sql("update device_codes set expires_at = now() - interval '1 second'")
    assert (await redeem(api, code)).status == 401

    assert (await redeem(api, await code_for(api, team.alice))).status == 201
    taken = await redeem(api, await code_for(api, team.alice))
    assert taken.status == 422
    assert "already have a machine" in taken.json["error"]["message"]


async def test_a_machine_is_taken_off_alone(api: Api):
    team = await new_team(api, "devices-remove")
    laptop = await redeem(api, await code_for(api, team.alice, device="desktop"))
    keys = {m["handle"]: m["api_key"] for m in laptop.json["members"]}

    # Not the machine the request comes from.
    own = await api.call("DELETE", "/v1/me/devices/laptop", key=keys["alice"])
    assert own.status == 422

    gone = await api.call("DELETE", "/v1/me/devices/laptop", key=team.alice)
    assert gone.status == 204
    stopped = await api.call("GET", "/v1/me", key=keys["alice/claude"])
    assert stopped.status == 401
    assert stopped.json["error"]["code"] == "key_stopped"
    assert "machine was taken off" in stopped.json["error"]["message"]
    # The first machine keeps working.
    assert (await api.call("GET", "/v1/me", key=team.claude)).status == 200
    assert (await api.call("DELETE", "/v1/me/devices/laptop", key=team.alice)).status == 404


async def test_someone_taken_off_cannot_bring_a_machine(api: Api):
    team = await new_team(api, "devices-taken-off")
    code = await code_for(api, team.bob)
    assert (await api.call("DELETE", "/v1/members/bob", key=team.alice)).status == 204
    assert (await redeem(api, code)).status == 401


async def test_an_agent_added_on_a_machine_goes_with_it(api: Api):
    team = await new_team(api, "devices-agent")
    laptop = await redeem(api, await code_for(api, team.alice, device="desktop"))
    keys = {m["handle"]: m["api_key"] for m in laptop.json["members"]}
    added = await api.call("POST", "/v1/agents", key=keys["alice"], body={"name": "codex"})
    assert added.status == 201, added.json

    assert (await api.call("DELETE", "/v1/me/devices/laptop", key=team.alice)).status == 204
    stopped = await api.call("GET", "/v1/me", key=added.json["api_key"])
    assert (stopped.status, stopped.json["error"]["code"]) == (401, "key_stopped")


async def test_a_code_stops_with_the_machine_that_made_it(api: Api):
    team = await new_team(api, "devices-code-stops")
    laptop = await redeem(api, await code_for(api, team.alice, device="desktop"))
    keys = {m["handle"]: m["api_key"] for m in laptop.json["members"]}
    from_laptop = await code_for(api, keys["alice"])
    assert (await api.call("DELETE", "/v1/me/devices/laptop", key=team.alice)).status == 204
    assert (await redeem(api, from_laptop, device="phone")).status == 401


async def test_a_code_can_be_looked_at_before_it_is_used(api: Api):
    team = await new_team(api, "devices-info")
    code = await code_for(api, team.alice)
    info = await api.call("GET", f"/v1/devices/info?code={code}")
    assert info.status == 200, info.json
    assert (info.json["board"]["id"], info.json["owner"]) == (team.board_id, "alice")
    # Looking does not use it.
    assert (await redeem(api, code)).status == 201
    assert (await api.call("GET", f"/v1/devices/info?code={code}")).status == 401


async def test_the_first_machine_cannot_take_a_name_in_use(api: Api):
    team = await new_team(api, "devices-first-name")
    await redeem(api, await code_for(api, team.alice))  # "laptop", made from an unnamed machine
    clash = await api.call("POST", "/v1/me/devices", key=team.alice, body={"device": "laptop"})
    assert clash.status == 422
