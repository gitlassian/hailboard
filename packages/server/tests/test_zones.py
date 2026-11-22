import pytest
from conftest import Api, new_team

from hailboard_server.errors import ApiError
from hailboard_server.paths import covers, normalize, overlaps


class TestPaths:
    def test_normalize(self):
        assert normalize("./web\\checkout//form.tsx") == "web/checkout/form.tsx"
        assert normalize(" src/ ") == "src"

    @pytest.mark.parametrize("bad", ["", "/etc/passwd", "C:/x", "../x", "a/../b", "."])
    def test_normalize_refuses_paths_outside_the_repository(self, bad):
        with pytest.raises(ApiError):
            normalize(bad)

    @pytest.mark.parametrize(
        "bad",
        ["web\ncart", "web/\x1b[2Jcart", "a\tb", "web/cart\x7f", "a\x85b", "a\u2028b", "a\u202eb"],
    )
    def test_normalize_refuses_line_breaks_and_control_characters(self, bad):
        # A path is printed on one line of a listing and inside a board event.
        with pytest.raises(ApiError):
            normalize(bad)

    @pytest.mark.parametrize(
        ("a", "b", "meet"),
        [
            ("web/checkout", "web/checkout/form.tsx", True),
            ("web/checkout/**", "web/checkout/form.tsx", True),
            ("web/cart", "web/cart-old", False),
            ("web/checkout", "web/cart", False),
            ("web", "web/cart/**", True),
            ("**/*.css", "web/cart", True),
            ("*.md", "src/api", True),
            ("src/api.ts", "src/api.ts", True),
            ("src/api.ts", "src/api.tsx", False),
            ("web/*.css", "web/checkout/**", True),
            ("web/*.css", "api/**", False),
        ],
    )
    def test_overlaps(self, a, b, meet):
        assert overlaps(a, b) is meet
        assert overlaps(b, a) is meet

    @pytest.mark.parametrize(
        ("zone", "file", "inside"),
        [
            ("web/checkout", "web/checkout/form.tsx", True),
            ("web/checkout", "web/checkout", True),
            ("web/checkout", "web/checkout-old/form.tsx", False),
            ("web/checkout/**", "web/checkout/a/b.ts", True),
            ("web/*.css", "web/main.css", True),
            ("web/*.css", "web/a/main.css", False),
            ("**/*.css", "web/a/main.css", True),
            ("**/*.css", "main.css", True),
            ("src/?.ts", "src/a.ts", True),
            ("src/?.ts", "src/ab.ts", False),
        ],
    )
    def test_covers(self, zone, file, inside):
        assert covers(zone, file) is inside


async def claim(api: Api, key: str, paths: list[str], **body):
    return await api.call("POST", "/v1/zones", key=key, body={"paths": paths, **body})


async def board_events(api: Api, key: str) -> list[str]:
    history = (await api.call("GET", "/v1/messages", key=key)).json["messages"]
    return [m["body"] for m in history if m["kind"] == "activity"]


class TestClaims:
    async def test_a_name_loses_what_cannot_be_read(self, api: Api):
        team = await new_team(api)
        made = await claim(api, team.claude, ["web"], name="Check\u202eout\x1b[2J", note="a\x07b")
        assert made.status == 201
        assert (made.json["zone"]["name"], made.json["zone"]["note"]) == ("Checkout[2J", "ab")

    async def test_the_check_takes_any_file_name(self, api: Api):
        # A file name may hold a tab. The check before an edit must still answer for the others.
        team = await new_team(api)
        await claim(api, team.claude, ["web/cart"])
        res = await api.call(
            "GET", "/v1/zones/check?path=web/cart/a.tsx&path=notes/a%09b.md", key=team.codex
        )
        assert res.status == 200, res.json
        assert [c["path"] for c in res.json["conflicts"]] == ["web/cart/a.tsx"]

    async def test_a_name_and_a_note_are_kept_on_one_line(self, api: Api):
        # Both are printed on one line and inside the board event; a line break in them would
        # let a member write what looks like the next entry of the log.
        team = await new_team(api)
        made = await claim(
            api, team.claude, ["web"], name=" Check\nout  now ", note="the\r\n#9 12:00  bob\tform"
        )
        assert made.status == 201
        assert (made.json["zone"]["name"], made.json["zone"]["note"]) == (
            "Check out now",
            "the #9 12:00 bob form",
        )
        assert await board_events(api, team.bob) == ["alice/claude took Check out now (web)."]

    async def test_claim_list_and_release(self, api: Api):
        team = await new_team(api)
        made = await claim(
            api, team.claude, ["web/checkout/**", "web/api.ts"], name="Checkout", note="the form"
        )
        assert made.status == 201 and made.json["overlaps"] == []
        zone = made.json["zone"]
        assert zone["owner"] == "alice/claude" and zone["name"] == "Checkout"
        assert zone["paths"] == ["web/checkout/**", "web/api.ts"] and zone["stale"] is False

        listing = await api.call("GET", "/v1/zones", key=team.bob)
        assert [z["name"] for z in listing.json["zones"]] == ["Checkout"]

        refused = await api.call("DELETE", f"/v1/zones/{zone['id']}", key=team.codex)
        assert refused.status == 403 and "alice/claude" in refused.json["error"]["message"]
        assert (await api.call("DELETE", f"/v1/zones/{zone['id']}", key=team.claude)).status == 204
        assert (await api.call("GET", "/v1/zones", key=team.bob)).json["zones"] == []
        assert (await api.call("DELETE", f"/v1/zones/{zone['id']}", key=team.claude)).status == 404

    async def test_the_first_path_names_a_claim_without_a_name(self, api: Api):
        team = await new_team(api)
        made = await claim(api, team.claude, ["./web\\cart/**"])
        assert made.json["zone"]["name"] == "web/cart/**"
        assert made.json["zone"]["paths"] == ["web/cart/**"]

    async def test_claiming_the_same_name_again_replaces_the_paths(self, api: Api):
        team = await new_team(api)
        first = await claim(api, team.claude, ["web/a"], name="Part")
        again = await claim(api, team.claude, ["web/b", "web/b/", "web/c"], name="Part", note="n")
        assert (first.status, again.status) == (201, 200)
        assert again.json["zone"]["id"] == first.json["zone"]["id"]
        assert again.json["zone"]["paths"] == ["web/b", "web/c"]
        zones = (await api.call("GET", "/v1/zones", key=team.alice)).json["zones"]
        assert len(zones) == 1 and zones[0]["note"] == "n"

    async def test_claims_are_announced_without_filling_inboxes(self, api: Api):
        team = await new_team(api)
        made = await claim(api, team.claude, ["web/a"], name="Part")
        await claim(api, team.claude, ["web/b"], name="Part")
        await api.call("DELETE", f"/v1/zones/{made.json['zone']['id']}", key=team.claude)
        assert await board_events(api, team.bob) == [
            "alice/claude took Part (web/a).",
            "alice/claude changed their claim on Part (web/b).",
            "alice/claude released Part.",
        ]
        for key in (team.alice, team.bob, team.codex):
            assert (await api.call("GET", "/v1/inbox", key=key)).json["messages"] == []

    async def test_an_overlap_is_reported_and_the_owner_is_told(self, api: Api):
        team = await new_team(api)
        await claim(api, team.codex, ["web/checkout"], name="Checkout")
        made = await claim(api, team.claude, ["web/checkout/form", "api/**"], name="Form")
        assert made.status == 201  # a claim is never refused for overlapping
        [overlap] = made.json["overlaps"]
        assert overlap["zone"]["owner"] == "bob/codex" and overlap["zone"]["name"] == "Checkout"
        assert overlap["paths"] == ["web/checkout/form"]

        inbox = (await api.call("GET", "/v1/inbox", key=team.codex)).json["messages"]
        [note] = [m for m in inbox if m["kind"] == "message"]
        assert note["from"] == "alice/claude"
        assert note["body"].startswith("@bob/codex heads-up:") and '"Form"' in note["body"]
        # Nobody else is bothered.
        assert (await api.call("GET", "/v1/inbox", key=team.bob)).json["messages"] == []

    async def test_a_zone_of_your_own_never_overlaps(self, api: Api):
        team = await new_team(api)
        await claim(api, team.claude, ["web"], name="All")
        made = await claim(api, team.claude, ["web/cart"], name="Cart")
        assert made.json["overlaps"] == []

    async def test_limits_and_bad_paths(self, api: Api):
        team = await new_team(api)
        assert (await claim(api, team.claude, ["/etc"])).status == 422
        assert (await claim(api, team.claude, ["a/../b"])).status == 422
        assert (await claim(api, team.claude, [])).status == 422
        assert (await claim(api, team.claude, [f"p{i}" for i in range(21)])).status == 422
        for i in range(20):
            assert (await claim(api, team.claude, [f"dir{i}"])).status == 201
        full = await claim(api, team.claude, ["one-more"])
        assert full.status == 422 and "20 zones" in full.json["error"]["message"]
        # Changing a zone you hold is still allowed at the limit.
        assert (await claim(api, team.claude, ["dir0/x"], name="dir0")).status == 200

    async def test_a_zone_goes_stale_when_its_owner_is_gone(self, api: Api):
        team = await new_team(api)
        await claim(api, team.claude, ["web/a"], name="Part")
        await api.sql(
            "update members set last_seen_at = now() - interval '7 hours' where handle = 'alice/claude'"
        )
        [zone] = (await api.call("GET", "/v1/zones", key=team.bob)).json["zones"]
        assert zone["stale"] is True

    async def test_requires_a_member(self, api: Api):
        assert (await api.call("GET", "/v1/zones")).status == 401


class TestCheck:
    async def test_lists_files_inside_somebody_elses_zone(self, api: Api):
        team = await new_team(api)
        await claim(api, team.codex, ["web/checkout/**", "api/users.ts"], name="Checkout")
        await claim(api, team.claude, ["docs"], name="Docs")
        q = "path=web/checkout/form.tsx&path=docs/a.md&path=api/users.ts&path=web/cart/x.ts"
        res = await api.call("GET", f"/v1/zones/check?{q}", key=team.claude)
        assert [c["path"] for c in res.json["conflicts"]] == [
            "web/checkout/form.tsx",
            "api/users.ts",
        ]
        assert res.json["conflicts"][0]["zone"]["owner"] == "bob/codex"
        # The owner of the zone is not in conflict with it.
        own = await api.call("GET", "/v1/zones/check?path=web/checkout/form.tsx", key=team.codex)
        assert own.json["conflicts"] == []

    async def test_needs_a_path_and_refuses_bad_ones(self, api: Api):
        team = await new_team(api)
        assert (await api.call("GET", "/v1/zones/check", key=team.claude)).status == 422
        assert (await api.call("GET", "/v1/zones/check?path=../x", key=team.claude)).status == 422
