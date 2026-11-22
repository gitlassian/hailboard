from pathlib import Path

import httpx
import pytest
from conftest import Api, new_team

from hailboard_server.app import create_app
from hailboard_server.config import Config


async def post(api: Api, key: str, body: str) -> int:
    res = await api.call("POST", "/v1/messages", key=key, body={"body": body})
    assert res.status == 201
    return res.json["message"]["seq"]


class TestFeedApi:
    async def test_board_name(self, api: Api):
        team = await new_team(api, name="launch")
        res = await api.call("GET", f"/v1/feed/board?token={team.read_token}")
        assert res.status == 200 and res.json["name"] == "launch"
        assert (await api.call("GET", "/v1/feed/board?token=rd_nope")).status == 401

    async def test_pages_back_with_before(self, api: Api):
        team = await new_team(api)
        for i in range(1, 6):
            await post(api, team.claude, f"m{i}")
        token = team.read_token

        latest = await api.call("GET", f"/v1/feed/messages?token={token}&limit=2")
        assert [m["body"] for m in latest.json["messages"]] == ["m4", "m5"]

        older = await api.call("GET", f"/v1/feed/messages?token={token}&limit=2&before=4")
        assert [m["body"] for m in older.json["messages"]] == ["m2", "m3"]

        oldest = await api.call("GET", f"/v1/feed/messages?token={token}&limit=2&before=2")
        assert [m["body"] for m in oldest.json["messages"]] == ["m1"]

        none = await api.call("GET", f"/v1/feed/messages?token={token}&before=1")
        assert none.json["messages"] == []


def web_client(web_dir: Path | None) -> httpx.AsyncClient:
    # The page routes need no database, so the app's lifespan (which opens one) is not run.
    app = create_app(
        Config(database_url="postgres://unused", web_dir=str(web_dir) if web_dir else None)
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


@pytest.fixture
def built(tmp_path: Path) -> Path:
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<!doctype html><title>feed</title>")
    (tmp_path / "assets" / "index-abc123.js").write_text("console.log(1)")
    return tmp_path


class TestPage:
    @pytest.mark.parametrize("path", ["/feed/rd_secret", "/join/inv_secret"])
    async def test_serves_the_page_for_feed_and_join_links(self, built: Path, path: str):
        async with web_client(built) as client:
            res = await client.get(path)
        assert res.status_code == 200
        assert res.headers["content-type"].startswith("text/html")
        assert "<title>feed</title>" in res.text
        # The URL is the secret: never pass it on, cache it or index it.
        assert res.headers["referrer-policy"] == "no-referrer"
        assert res.headers["cache-control"] == "no-store"
        assert "noindex" in res.headers["x-robots-tag"]
        assert "frame-ancestors 'none'" in res.headers["content-security-policy"]

    async def test_serves_hashed_assets_for_ever(self, built: Path):
        async with web_client(built) as client:
            res = await client.get("/assets/index-abc123.js")
            missing = await client.get("/assets/nope.js")
        assert res.status_code == 200 and res.text == "console.log(1)"
        assert "immutable" in res.headers["cache-control"]
        assert missing.status_code == 404

    async def test_explains_when_the_page_is_not_built(self, tmp_path: Path):
        async with web_client(tmp_path / "empty") as client:
            res = await client.get("/feed/rd_secret")
        assert res.status_code == 404
        assert "not built" in res.json()["error"]["message"]
        assert res.headers["referrer-policy"] == "no-referrer"

    async def test_other_paths_stay_unknown(self, built: Path):
        async with web_client(built) as client:
            assert (await client.get("/feed")).status_code == 404
            assert (await client.get("/feed/a/b")).status_code == 404
