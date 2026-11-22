import asyncio
import contextlib
import json
import time

import httpx
from conftest import Api, new_team


async def post(api: Api, key: str, body: str):
    return await api.call("POST", "/v1/messages", key=key, body={"body": body})


class Sse:
    """Minimal Server-Sent Events reader on top of an httpx streaming response."""

    def __init__(self, response: httpx.Response):
        self.response = response
        self.lines = response.aiter_lines()
        self.events: list[dict[str, str]] = []

    async def _next_event(self) -> dict[str, str]:
        event: dict[str, str] = {}
        async for line in self.lines:
            if line == "":
                if event:
                    return event
                continue
            if line.startswith(":"):
                continue
            field, _, value = line.partition(":")
            event[field] = value.removeprefix(" ")
        raise EOFError("stream closed")

    async def until(self, done, seconds: float = 3.0):
        with contextlib.suppress(TimeoutError):
            async with asyncio.timeout(seconds):
                while not done(self.events):
                    self.events.append(await self._next_event())
        return self.events

    def of(self, name: str):
        return [e for e in self.events if e.get("event") == name]


@contextlib.asynccontextmanager
async def open_stream(api: Api, path: str, headers: dict | None = None):
    async with api.client.stream("GET", path, headers=headers) as response:
        yield response, Sse(response)


class TestWait:
    async def test_returns_at_once_when_something_is_waiting(self, api: Api):
        team = await new_team(api)
        await post(api, team.claude, "@bob/codex ready")
        start = time.monotonic()
        res = await api.call("GET", "/v1/inbox/wait?timeout=5", key=team.codex)
        assert res.status == 200 and len(res.json["messages"]) == 1
        assert time.monotonic() - start < 1

    async def test_wakes_up_as_soon_as_a_message_arrives(self, api: Api):
        team = await new_team(api)
        waiting = asyncio.create_task(api.call("GET", "/v1/inbox/wait?timeout=10", key=team.codex))
        await asyncio.sleep(0.3)
        sent_at = time.monotonic()
        await post(api, team.claude, "@bob/codex now")

        res = await waiting
        assert res.status == 200
        assert res.json["messages"][0]["body"] == "@bob/codex now"
        assert res.json["messages"][0]["reason"] == "mention"
        assert time.monotonic() - sent_at < 1.5

        # The cursor moved: the next read is empty.
        assert (await api.call("GET", "/v1/inbox", key=team.codex)).json["messages"] == []

    async def test_answers_204_on_timeout_and_ignores_messages_for_others(self, api: Api):
        team = await new_team(api)
        waiting = asyncio.create_task(api.call("GET", "/v1/inbox/wait?timeout=1", key=team.codex))
        await asyncio.sleep(0.1)
        await post(api, team.claude, "@alice hello someone else")
        res = await waiting
        assert res.status == 204 and res.json is None

    async def test_a_message_goes_to_only_one_of_two_concurrent_waits(self, api: Api):
        team = await new_team(api)
        a = asyncio.create_task(api.call("GET", "/v1/inbox/wait?timeout=2", key=team.codex))
        b = asyncio.create_task(api.call("GET", "/v1/inbox/wait?timeout=2", key=team.codex))
        await asyncio.sleep(0.3)
        await post(api, team.claude, "@bob/codex only once")
        statuses = sorted(r.status for r in await asyncio.gather(a, b))
        assert statuses == [200, 204]

    async def test_limits_concurrent_waits_per_member(self, api: Api):
        team = await new_team(api)
        results = await asyncio.gather(
            *(api.call("GET", "/v1/inbox/wait?timeout=1", key=team.codex) for _ in range(11))
        )
        limited = [r for r in results if r.status == 429]
        assert len(limited) == 1
        assert limited[0].headers["retry-after"] == "5"
        assert limited[0].json["error"]["code"] == "rate_limited"
        assert sum(r.status == 204 for r in results) == 10

        # Slots are released afterwards.
        assert (await api.call("GET", "/v1/inbox/wait?timeout=1", key=team.codex)).status == 204

    async def test_validates_the_timeout_and_requires_authentication(self, api: Api):
        team = await new_team(api)
        assert (await api.call("GET", "/v1/inbox/wait?timeout=0", key=team.codex)).status == 422
        assert (await api.call("GET", "/v1/inbox/wait?timeout=56", key=team.codex)).status == 422
        assert (await api.call("GET", "/v1/inbox/wait")).status == 401

    async def test_stops_waiting_when_the_client_disconnects(self, api: Api):
        team = await new_team(api)
        me = await api.call("GET", "/v1/me", key=team.codex)
        member_id = me.json["member"]["id"]

        waiting = asyncio.create_task(api.call("GET", "/v1/inbox/wait?timeout=30", key=team.codex))
        await asyncio.sleep(0.3)
        assert api.app.state.active_waits.get(member_id) == 1
        waiting.cancel()  # closes the connection
        with contextlib.suppress(asyncio.CancelledError):
            await waiting

        # The server notices and frees the slot well before the 30 s timeout.
        async with asyncio.timeout(4):
            while member_id in api.app.state.active_waits:  # noqa: ASYNC110 - polling on purpose
                await asyncio.sleep(0.1)

        # The abandoned wait must not swallow the next message.
        await post(api, team.claude, "@bob/codex after disconnect")
        inbox = await api.call("GET", "/v1/inbox", key=team.codex)
        assert len(inbox.json["messages"]) == 1

    async def test_waiting_for_messages_is_not_activity(self, api: Api):
        team = await new_team(api)
        await api.sql(
            "update members set last_active_at = null where board_id = %s", (team.board_id,)
        )
        await api.call("GET", "/v1/inbox/wait?timeout=1", key=team.codex)
        members = (await api.call("GET", "/v1/members", key=team.alice)).json["members"]
        codex = next(m for m in members if m["handle"] == "bob/codex")
        assert codex["last_seen_at"] is not None and codex["last_active_at"] is None
        await api.call("GET", "/v1/inbox", key=team.codex)
        members = (await api.call("GET", "/v1/members", key=team.alice)).json["members"]
        assert next(m for m in members if m["handle"] == "bob/codex")["last_active_at"]


class TestFeed:
    async def test_serves_history_and_members_with_a_read_token(self, api: Api):
        team = await new_team(api)
        await post(api, team.claude, "hello feed")
        messages = await api.call("GET", f"/v1/feed/messages?token={team.read_token}")
        assert messages.status == 200
        assert [m["body"] for m in messages.json["messages"]] == ["hello feed"]
        members = await api.call("GET", f"/v1/feed/members?token={team.read_token}")
        assert len(members.json["members"]) == 4

    async def test_rejects_missing_wrong_join_and_expired_tokens(self, api: Api):
        team = await new_team(api)
        assert (await api.call("GET", "/v1/feed/messages")).status == 422
        assert (await api.call("GET", "/v1/feed/messages?token=rd_nope")).status == 401
        assert (await api.call("GET", f"/v1/feed/messages?token={team.join_token}")).status == 401
        assert (await api.call("GET", f"/v1/stream?token={team.join_token}")).status == 401

        await api.sql(
            """update board_tokens
                  set created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'
                where board_id = %s and scope = 'read'""",
            (team.board_id,),
        )
        assert (await api.call("GET", f"/v1/feed/messages?token={team.read_token}")).status == 401

    async def test_does_not_leak_another_boards_messages(self, api: Api):
        a, b = await new_team(api, "a"), await new_team(api, "b")
        await post(api, a.claude, "secret of a")
        res = await api.call("GET", f"/v1/feed/messages?token={b.read_token}")
        assert res.json["messages"] == []


class TestStream:
    async def test_sends_members_first_then_new_messages_with_their_number_as_id(self, api: Api):
        team = await new_team(api)
        await post(api, team.claude, "old message")

        async with open_stream(api, f"/v1/stream?token={team.read_token}") as (response, sse):
            assert response.status_code == 200
            assert "text/event-stream" in response.headers["content-type"]
            # Initial member snapshot; no history without Last-Event-ID.
            await sse.until(lambda e: sum(x.get("event") == "member" for x in e) >= 4)
            assert sse.of("message") == []

            await post(api, team.claude, "@bob/codex live")
            await sse.until(lambda e: any(x.get("event") == "message" for x in e))
            (live,) = sse.of("message")
            assert live["id"] == "2"
            data = json.loads(live["data"])
            assert (data["seq"], data["body"], data["from"]) == (
                2,
                "@bob/codex live",
                "alice/claude",
            )

    async def test_replays_what_was_missed_using_last_event_id(self, api: Api):
        team = await new_team(api)
        for text in ("one", "two", "three"):
            await post(api, team.claude, text)

        path = f"/v1/stream?token={team.read_token}"
        async with open_stream(api, path, headers={"last-event-id": "1"}) as (_, sse):
            await sse.until(lambda e: sum(x.get("event") == "message" for x in e) >= 2)
            assert [e["id"] for e in sse.of("message")] == ["2", "3"]

    async def test_reports_status_changes_of_members(self, api: Api):
        team = await new_team(api)
        async with open_stream(api, f"/v1/stream?token={team.read_token}") as (_, sse):
            await sse.until(lambda e: sum(x.get("event") == "member" for x in e) >= 4)
            await api.call("PUT", "/v1/me/status", key=team.codex, body={"text": "building"})
            await post(api, team.claude, "tick")  # wakes the stream, which re-checks members
            await sse.until(
                lambda e: any(x.get("event") == "member" and "building" in x["data"] for x in e)
            )
            assert any("building" in e["data"] for e in sse.of("member"))

    async def test_reports_tasks_as_they_change(self, api: Api):
        team = await new_team(api)
        await api.call("POST", "/v1/tasks", key=team.alice, body={"title": "Cart"})
        async with open_stream(api, f"/v1/stream?token={team.read_token}") as (_, sse):
            # The current tasks come first.
            await sse.until(lambda e: any(x.get("event") == "task" for x in e))
            assert '"state":"todo"' in sse.of("task")[0]["data"]
            await api.call("POST", "/v1/tasks/1/take", key=team.codex)
            await sse.until(
                lambda e: any(x.get("event") == "task" and "bob/codex" in x["data"] for x in e)
            )
            assert '"state":"doing"' in sse.of("task")[-1]["data"]

    async def test_reports_when_a_message_reaches_its_addressee(self, api: Api):
        team = await new_team(api)
        await post(api, team.claude, "@bob/codex the endpoint is ready")
        async with open_stream(api, f"/v1/stream?token={team.read_token}") as (_, sse):
            await sse.until(lambda e: sum(x.get("event") == "member" for x in e) >= 4)
            # Reading the inbox moves the cursor, which wakes the stream without a new message.
            await api.call("GET", "/v1/inbox", key=team.codex)

            def codex_saw_it(events):
                for event in events:
                    if event.get("event") == "member":
                        data = json.loads(event["data"])
                        if data["handle"] == "bob/codex" and data["read_up_to"] == 1:
                            return True
                return False

            started = time.monotonic()
            await sse.until(codex_saw_it)
            assert codex_saw_it(sse.events)
            assert time.monotonic() - started < 2  # woken at once, not at the next ping
