from conftest import Api, new_team


async def put(api: Api, key: str, name: str, **body):
    return await api.call("PUT", f"/v1/docs/{name}", key=key, body=body)


async def events(api: Api, key: str) -> list[str]:
    history = (await api.call("GET", "/v1/messages", key=key)).json["messages"]
    return [m["body"] for m in history if m["kind"] == "activity"]


class TestDocuments:
    async def test_create_read_update_and_list(self, api: Api):
        team = await new_team(api)
        created = await put(api, team.claude, "plan.md", body="# Plan\n1. tokens")
        assert created.status == 201
        assert created.json["version"] == 1 and created.json["updated_by"] == "alice/claude"

        updated = await put(api, team.codex, "plan.md", body="# Plan\n1. tokens\n2. nav")
        assert (updated.status, updated.json["version"]) == (200, 2)

        doc = await api.call("GET", "/v1/docs/plan.md", key=team.bob)
        assert doc.json["body"] == "# Plan\n1. tokens\n2. nav"
        assert doc.json["updated_by"] == "bob/codex"
        old = await api.call("GET", "/v1/docs/plan.md?version=1", key=team.bob)
        assert (old.json["body"], old.json["updated_by"]) == ("# Plan\n1. tokens", "alice/claude")

        listing = await api.call("GET", "/v1/docs", key=team.alice)
        [info] = listing.json["documents"]
        assert info["name"] == "plan.md" and info["size"] == len("# Plan\n1. tokens\n2. nav")
        assert "body" not in info

    async def test_changes_are_announced_without_filling_inboxes(self, api: Api):
        team = await new_team(api)
        await put(api, team.claude, "api/users.md", body="GET /users")
        await put(api, team.claude, "api/users.md", body="GET /users\nPOST /users")
        await put(api, team.claude, "api/users.md", body="GET /users\nPOST /users")  # no change
        await put(api, team.alice, "api/users.md", body="GET /users\nPOST /users", pinned=True)
        await api.call("DELETE", "/v1/docs/api/users.md", key=team.bob)
        assert await events(api, team.alice) == [
            "alice/claude added the document api/users.md.",
            "alice/claude updated the document api/users.md (version 2).",
            "alice pinned api/users.md as board context.",
            "bob removed the document api/users.md.",
        ]
        for key in (team.alice, team.bob, team.codex):
            assert (await api.call("GET", "/v1/inbox", key=key)).json["messages"] == []

    async def test_refuses_to_overwrite_a_change_made_meanwhile(self, api: Api):
        team = await new_team(api)
        await put(api, team.claude, "plan.md", body="v1")
        await put(api, team.codex, "plan.md", body="v2 by codex", base_version=1)
        stale = await put(api, team.claude, "plan.md", body="v2 by claude", base_version=1)
        assert stale.status == 409
        assert "at version 2, not 1" in stale.json["error"]["message"]
        fresh = await put(api, team.claude, "new.md", body="x", base_version=0)
        assert fresh.status == 201

    async def test_pinned_documents_come_first(self, api: Api):
        team = await new_team(api)
        await put(api, team.claude, "a.md", body="a")
        await put(api, team.claude, "context.md", body="we build X", pinned=True)
        names = [
            d["name"] for d in (await api.call("GET", "/v1/docs", key=team.bob)).json["documents"]
        ]
        assert names == ["context.md", "a.md"]
        unpinned = await put(api, team.claude, "context.md", body="we build X", pinned=False)
        assert unpinned.json["pinned"] is False

    async def test_validates_names_sizes_and_boards(self, api: Api):
        team, other = await new_team(api), await new_team(api)
        for bad in ("../x", ".hidden", "a//b", "a b", "x" * 121):
            res = await put(api, team.claude, bad, body="x")
            assert res.status in (404, 422), bad
        assert (await put(api, team.claude, "big.md", body="x" * 100_001)).status == 422
        await put(api, team.claude, "secret.md", body="ours")
        assert (await api.call("GET", "/v1/docs/secret.md", key=other.alice)).status == 404
        assert (await api.call("GET", "/v1/docs/missing.md", key=team.alice)).status == 404
        assert (await api.call("DELETE", "/v1/docs/missing.md", key=team.alice)).status == 404
        assert (await api.call("GET", "/v1/docs")).status == 401

    async def test_the_feed_reads_documents_with_a_read_token(self, api: Api):
        team = await new_team(api)
        await put(api, team.claude, "plan.md", body="# Plan")
        listing = await api.call("GET", f"/v1/feed/docs?token={team.read_token}")
        assert [d["name"] for d in listing.json["documents"]] == ["plan.md"]
        doc = await api.call("GET", f"/v1/feed/docs/plan.md?token={team.read_token}")
        assert doc.json["body"] == "# Plan"
        assert (await api.call("GET", "/v1/feed/docs?token=rd_nope")).status == 401
