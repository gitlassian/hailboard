import hashlib
from dataclasses import replace

import pytest
from conftest import Api, Team, new_team

from hailboard_server.config import load_config
from hailboard_server.files import expire_files
from hailboard_server.routes import files as files_route
from hailboard_server.schemas import MAX_FILE_BYTES

YAML = b"provider: stripe\nretries: 3\n"


async def send(api: Api, key: str, to: list[str] | str, content: bytes = YAML, **params):
    query = {"name": "payments.yaml", "to": [to] if isinstance(to, str) else to, **params}
    return await api.client.post(
        "/v1/files",
        params=query,
        content=content,
        headers={"authorization": f"Bearer {key}", "content-type": "application/octet-stream"},
    )


async def download(api: Api, key: str, number: int):
    return await api.client.get(
        f"/v1/files/{number}/content", headers={"authorization": f"Bearer {key}"}
    )


async def join(api: Api, team: Team, owner: str) -> tuple[str, str]:
    """One more person with an agent on the team's board: the keys of both."""
    res = await api.call(
        "POST",
        "/v1/boards/join",
        body={
            "join_token": team.join_token,
            "owner": owner,
            "members": [
                {"handle": owner, "kind": "human"},
                {"handle": f"{owner}/claude", "kind": "agent"},
            ],
        },
    )
    assert res.status == 201, res.json
    keys = {m["handle"]: m["api_key"] for m in res.json["members"]}
    return keys[owner], keys[f"{owner}/claude"]


class TestSending:
    async def test_a_file_reaches_the_member_it_is_sent_to(self, api: Api):
        team = await new_team(api)
        sent = await send(api, team.claude, "bob/codex", note="the config you asked for")
        assert sent.status_code == 201, sent.text
        file, message = sent.json()["file"], sent.json()["message"]
        assert (file["number"], file["name"], file["size"]) == (1, "payments.yaml", len(YAML))
        assert (file["from"], file["to"], file["seq"]) == ("alice/claude", ["bob/codex"], 1)
        assert file["sha256"] == hashlib.sha256(YAML).hexdigest()
        assert file["available"] is True and file["encryption"] is None
        assert message["body"] == "@bob/codex the config you asked for"
        assert message["recipients"] == ["bob/codex"]
        assert [f["number"] for f in message["files"]] == [1]

        inbox = (await api.call("GET", "/v1/inbox", key=team.codex)).json["messages"]
        assert [(m["seq"], m["files"][0]["name"]) for m in inbox] == [(1, "payments.yaml")]

        got = await download(api, team.codex, 1)
        assert got.status_code == 200 and got.content == YAML
        assert got.headers["content-type"] == "application/octet-stream"
        assert got.headers["content-disposition"] == "attachment; filename*=UTF-8''payments.yaml"
        assert got.headers["x-content-type-options"] == "nosniff"
        assert got.headers["x-file-sha256"] == file["sha256"]

    async def test_without_a_note_the_message_says_what_it_carries(self, api: Api):
        team = await new_team(api)
        sent = await send(api, team.claude, ["bob/codex", "@bob", "bob/codex"])
        assert sent.json()["message"]["body"] == "@bob/codex @bob a file for you"
        assert sent.json()["file"]["to"] == ["bob", "bob/codex"]

    async def test_numbers_count_per_board(self, api: Api):
        one, two = await new_team(api), await new_team(api)
        assert (await send(api, one.claude, "bob/codex")).json()["file"]["number"] == 1
        assert (await send(api, one.codex, "alice/claude")).json()["file"]["number"] == 2
        assert (await send(api, two.claude, "bob/codex")).json()["file"]["number"] == 1

    async def test_binary_content_comes_back_as_it_was_sent(self, api: Api):
        team = await new_team(api)
        blob = bytes(range(256)) * 64
        await send(api, team.claude, "bob/codex", blob, name="logo.png")
        assert (await download(api, team.codex, 1)).content == blob

    async def test_the_name_is_the_last_part_of_a_path(self, api: Api):
        team = await new_team(api)
        sent = await send(api, team.claude, "bob/codex", name="../../etc/Конфиг v2.yaml")
        assert sent.json()["file"]["name"] == "Конфиг v2.yaml"
        got = await download(api, team.codex, 1)
        assert "filename*=UTF-8''%D0%9A" in got.headers["content-disposition"]

    @pytest.mark.parametrize("name", ["..", "a/..", "dir/", "bad\nname.txt", "   "])
    async def test_a_name_that_is_not_a_file_name_is_refused(self, api: Api, name: str):
        team = await new_team(api)
        sent = await send(api, team.claude, "bob/codex", name=name)
        assert sent.status_code == 422, sent.text
        assert sent.json()["error"]["message"].startswith("name:")

    async def test_a_name_cannot_address_the_message(self, api: Api):
        team = await new_team(api)
        sent = await send(api, team.claude, "bob/codex", name="@all.txt")
        assert sent.status_code == 201
        assert sent.json()["message"]["recipients"] == ["bob/codex"]
        assert sent.json()["message"]["mention_all"] is False


class TestRefusals:
    async def test_an_empty_file(self, api: Api):
        team = await new_team(api)
        sent = await send(api, team.claude, "bob/codex", b"")
        assert sent.status_code == 422 and "empty" in sent.json()["error"]["message"]

    async def test_a_file_over_the_limit(self, api: Api):
        team = await new_team(api)
        fits = await send(api, team.claude, "bob/codex", b"x" * MAX_FILE_BYTES)
        assert fits.status_code == 201
        over = await send(api, team.claude, "bob/codex", b"x" * (MAX_FILE_BYTES + 1))
        assert over.status_code == 413
        assert over.json()["error"] == {
            "code": "too_large",
            "message": "a file can be at most 5 MB",
        }
        assert await api.sql(
            "select count(*) as n from messages where board_id = %s", (team.board_id,)
        ) == [{"n": 1}]

    async def test_a_board_that_holds_too_much(self, api: Api, monkeypatch: pytest.MonkeyPatch):
        team = await new_team(api)
        monkeypatch.setattr(files_route, "MAX_BOARD_FILE_BYTES", 2 * len(YAML))
        assert (await send(api, team.claude, "bob/codex")).status_code == 201
        assert (await send(api, team.codex, "alice/claude")).status_code == 201
        full = await send(api, team.claude, "bob/codex")
        assert full.status_code == 413 and "holds" in full.json()["error"]["message"]
        # A file taken back makes room, and the refused one took no number.
        await api.call("DELETE", "/v1/files/1", key=team.claude)
        assert (await send(api, team.claude, "bob/codex")).json()["file"]["number"] == 3

    async def test_nobody_or_somebody_unknown_to_send_to(self, api: Api):
        team = await new_team(api)
        nobody = await api.client.post(
            "/v1/files",
            params={"name": "a.txt"},
            content=YAML,
            headers={"authorization": f"Bearer {team.claude}"},
        )
        assert nobody.status_code == 422
        unknown = await send(api, team.claude, ["bob/codex", "carol", "dan/codex"])
        assert unknown.status_code == 422
        assert unknown.json()["error"]["message"] == "to: not on this board: carol, dan/codex"
        for wrong in ("all", "human", "bob codex", "bob\x00"):
            refused = await send(api, team.claude, ["bob/codex", wrong])
            assert refused.status_code == 422, wrong
            assert refused.json()["error"]["message"].startswith("to: not a member's handle")
        me = await send(api, team.claude, "alice/claude")
        assert me.status_code == 422 and "yourself" in me.json()["error"]["message"]

    async def test_a_note_that_would_bring_in_someone_else(self, api: Api):
        team = await new_team(api)
        await join(api, team, "carol")
        for note in ("@all take a look", "@human please check"):
            sent = await send(api, team.claude, "bob/codex", note=note)
            assert sent.status_code == 422, note
            assert sent.json()["error"]["message"].startswith("note: @all and @human")
        outsider = await send(api, team.claude, "bob/codex", note="@carol you may want it too")
        assert outsider.status_code == 422
        assert outsider.json()["error"]["message"].startswith("the file would also reach carol:")
        unreadable = await send(api, team.claude, "bob/codex", note="line\x00one\x1b[2Ktwo")
        assert unreadable.status_code == 422
        assert unreadable.json()["error"]["message"].startswith("note:")

        # Bob can get what his agent gets, so naming him gives nothing away.
        fine = await send(api, team.claude, "bob/codex", note="@bob as promised")
        assert fine.status_code == 201
        assert fine.json()["file"]["to"] == ["bob", "bob/codex"]
        left = await api.sql(
            "select count(*) as n from files where board_id = %s", (team.board_id,)
        )
        assert left == [{"n": 1}]

    async def test_a_reply_to_someone_the_file_is_not_for(self, api: Api):
        team = await new_team(api)
        await join(api, team, "carol")

        async def say(key: str, body: str) -> int:
            posted = await api.call("POST", "/v1/messages", key=key, body={"body": body})
            return posted.json["message"]["seq"]

        question = await say(team.bob, "who has the config?")
        request = await say(team.codex, "@alice/claude send it please")

        other = await send(api, team.claude, "carol/claude", reply_to=question)
        assert other.status_code == 422
        assert other.json()["error"]["message"].startswith("the file would also reach bob:")
        missing = await send(api, team.claude, "bob/codex", reply_to=9999)
        assert missing.status_code == 422
        answer = await send(api, team.claude, "bob/codex", reply_to=request)
        assert answer.status_code == 201
        assert answer.json()["message"]["reply_to"] == request
        # Bob asked and his agent gets the file: the answer reaches both, as both can get it.
        for_bob = await send(api, team.claude, "bob/codex", reply_to=question)
        assert for_bob.status_code == 201
        assert for_bob.json()["message"]["recipients"] == ["bob", "bob/codex"]
        # Nothing of the refused attempts is left on the board.
        left = await api.sql(
            "select count(*) as n from files where board_id = %s", (team.board_id,)
        )
        assert left == [{"n": 2}]

    async def test_a_name_that_hides_what_the_file_is(self, api: Api):
        team = await new_team(api)
        for name in ("report\u202egpj.exe", "a\u2066b.txt", "x\u0085y.txt", "\U0001f4c4" * 64):
            sent = await send(api, team.claude, "bob/codex", name=name)
            assert sent.status_code == 422, repr(name)
            assert sent.json()["error"]["message"].startswith("name:")
        # 63 four-byte characters and ".txt" are 256 bytes; one less fits.
        long = "\U0001f4c4" * 62 + ".txt"
        assert (await send(api, team.claude, "bob/codex", name=long)).status_code == 201

    async def test_a_server_that_holds_too_much(self, api: Api):
        team = await new_team(api)
        held = await api.sql(
            """select coalesce(sum(size), 0)::bigint as n from files
                where content is not null and expires_at > now()"""
        )
        usual = api.app.state.config
        api.app.state.config = replace(usual, files_total_bytes=held[0]["n"] + len(YAML))
        try:
            assert (await send(api, team.claude, "bob/codex")).status_code == 201
            # Another board does not help: the limit is for all of them together.
            other = await new_team(api)
            full = await send(api, other.claude, "bob/codex")
            assert full.status_code == 413
            assert "as many files as it has room for" in full.json()["error"]["message"]
        finally:
            api.app.state.config = usual

    async def test_no_key_and_a_read_link(self, api: Api):
        team = await new_team(api)
        await send(api, team.claude, "bob/codex")
        assert (await api.client.get("/v1/files/1/content")).status_code == 401
        with_link = await download(api, team.read_token, 1)
        assert with_link.status_code == 401
        assert (
            await api.client.post("/v1/files", params={"name": "a", "to": "bob"}, content=b"x")
        ).status_code == 401


class TestAccess:
    async def test_only_the_two_sides_can_get_the_file(self, api: Api):
        team = await new_team(api)
        carol, carol_agent = await join(api, team, "carol")
        await send(api, team.claude, "bob/codex")

        # Both sides, and the people they work for.
        for key in (team.claude, team.alice, team.codex, team.bob):
            assert (await download(api, key, 1)).status_code == 200
            assert (await api.call("GET", "/v1/files/1", key=key)).status == 200
            listed = (await api.call("GET", "/v1/files", key=key)).json["files"]
            assert [f["number"] for f in listed] == [1]

        for key in (carol, carol_agent):
            refused = await download(api, key, 1)
            assert refused.status_code == 403
            assert refused.json()["error"]["message"] == "file #1 was not sent to you"
            assert (await api.call("GET", "/v1/files/1", key=key)).status == 403
            assert (await api.call("GET", "/v1/files", key=key)).json["files"] == []

    async def test_an_invite_does_not_make_anyone_an_agent_of_somebody_else(self, api: Api):
        team = await new_team(api)
        await send(api, team.claude, "bob/codex")
        # Whoever holds the invite cannot join as one more agent of bob to get what bob gets.
        res = await api.call(
            "POST",
            "/v1/boards/join",
            body={
                "join_token": team.join_token,
                "owner": "bob",
                "members": [{"handle": "bob/other", "kind": "agent"}],
            },
        )
        assert res.status == 409
        assert res.json["error"]["message"] == '"bob" is already on this board'
        # Bob himself adds an agent with his own key, and it works for him.
        added = await api.call("POST", "/v1/agents", key=team.bob, body={"name": "claude"})
        assert added.status == 201
        assert (await download(api, added.json["api_key"], 1)).status_code == 200

    async def test_a_file_of_another_board_does_not_exist(self, api: Api):
        one, two = await new_team(api), await new_team(api)
        await send(api, one.claude, "bob/codex")
        assert (await download(api, two.codex, 1)).status_code == 404
        assert (await api.call("DELETE", "/v1/files/1", key=two.claude)).status == 404

    async def test_everyone_sees_that_a_file_was_sent_but_not_what_is_in_it(self, api: Api):
        team = await new_team(api)
        _, carol_agent = await join(api, team, "carol")
        await send(api, team.claude, "bob/codex")
        history = (await api.call("GET", "/v1/messages", key=carol_agent)).json["messages"]
        carrying = next(m for m in history if m["files"])
        assert carrying["files"][0]["name"] == "payments.yaml"
        assert set(carrying["files"][0]) == {"number", "name", "size", "expires_at", "available"}
        feed = await api.client.get("/v1/feed/messages", params={"token": team.read_token})
        assert feed.status_code == 200, feed.text
        assert any(m["files"] for m in feed.json()["messages"])

    async def test_the_list_is_newest_first(self, api: Api):
        team = await new_team(api)
        for name in ("a.txt", "b.txt", "c.txt"):
            await send(api, team.claude, "bob/codex", name=name)
        listed = (await api.call("GET", "/v1/files", key=team.codex)).json["files"]
        assert [f["name"] for f in listed] == ["c.txt", "b.txt", "a.txt"]
        one = (await api.call("GET", "/v1/files?limit=1", key=team.codex)).json["files"]
        assert [f["name"] for f in one] == ["c.txt"]


class TestGone:
    async def test_the_sender_takes_a_file_back(self, api: Api):
        team = await new_team(api)
        await send(api, team.claude, "bob/codex")
        refused = await api.call("DELETE", "/v1/files/1", key=team.codex)
        assert refused.status == 403
        assert refused.json["error"]["message"] == "only alice/claude can take this file back"
        assert (await download(api, team.codex, 1)).status_code == 200

        # The person the sending agent works for can as well.
        assert (await api.call("DELETE", "/v1/files/1", key=team.alice)).status == 204
        gone = await download(api, team.codex, 1)
        assert gone.status_code == 410 and gone.json()["error"]["code"] == "gone"
        info = (await api.call("GET", "/v1/files/1", key=team.codex)).json
        assert info["available"] is False
        history = (await api.call("GET", "/v1/messages", key=team.codex)).json["messages"]
        assert history[0]["files"][0]["available"] is False
        stored = await api.sql(
            "select content, removed_at from files where board_id = %s", (team.board_id,)
        )
        assert stored[0]["content"] is None and stored[0]["removed_at"] is not None
        assert (await api.call("DELETE", "/v1/files/1", key=team.claude)).status == 204

    async def test_a_file_is_kept_for_a_week(self, api: Api):
        team = await new_team(api)
        sent = (await send(api, team.claude, "bob/codex")).json()["file"]
        kept = await api.sql(
            "select extract(epoch from expires_at - created_at)::int as seconds from files where board_id = %s",
            (team.board_id,),
        )
        assert kept[0]["seconds"] == 7 * 24 * 3600
        assert sent["expires_at"] > sent["created_at"]

    async def test_after_its_time_the_content_goes_and_the_record_stays(self, api: Api):
        team = await new_team(api)
        await send(api, team.claude, "bob/codex")
        await send(api, team.claude, "bob/codex", name="fresh.txt")
        await api.sql(
            "update files set expires_at = now() - interval '1 minute' where board_id = %s and number = 1",
            (team.board_id,),
        )
        # Refused from the moment the time is up, also before the content is dropped.
        assert (await download(api, team.codex, 1)).status_code == 410
        assert await expire_files(api.pool) >= 1
        rows = await api.sql(
            "select number, content is null as dropped from files where board_id = %s order by number",
            (team.board_id,),
        )
        assert rows == [{"number": 1, "dropped": True}, {"number": 2, "dropped": False}]
        assert (await download(api, team.codex, 1)).status_code == 410
        assert (await download(api, team.codex, 2)).status_code == 200
        listed = (await api.call("GET", "/v1/files", key=team.codex)).json["files"]
        assert [(f["number"], f["available"]) for f in listed] == [(2, True), (1, False)]


def test_the_room_for_all_boards_is_set_in_megabytes():
    env = {"DATABASE_URL": "postgres://x"}
    assert load_config(env).files_total_bytes == 2048 * 1024 * 1024
    assert load_config({**env, "FILES_TOTAL_MB": "10"}).files_total_bytes == 10 * 1024 * 1024
    with pytest.raises(RuntimeError, match="FILES_TOTAL_MB"):
        load_config({**env, "FILES_TOTAL_MB": "lots"})
