import asyncio

from conftest import Api, new_team


async def add(api: Api, key: str, title: str, **body):
    return await api.call("POST", "/v1/tasks", key=key, body={"title": title, **body})


async def act(api: Api, key: str, number: int, action: str):
    return await api.call("POST", f"/v1/tasks/{number}/{action}", key=key)


async def board_events(api: Api, key: str) -> list[str]:
    history = (await api.call("GET", "/v1/messages", key=key)).json["messages"]
    return [m["body"] for m in history if m["kind"] == "activity"]


class TestTasks:
    async def test_add_take_and_finish(self, api: Api):
        team = await new_team(api)
        made = await add(api, team.alice, "Cart totals with discounts", part="cart")
        assert made.status == 201
        task = made.json
        assert (task["number"], task["state"], task["agents"]) == (1, "todo", [])
        assert task["part"] == "cart" and task["created_by"] == "alice"

        taken = await act(api, team.codex, 1, "take")
        assert taken.status == 200
        assert (taken.json["state"], taken.json["agents"]) == ("doing", ["bob/codex"])

        finished = await act(api, team.codex, 1, "done")
        assert finished.json["state"] == "done" and finished.json["done_at"] is not None
        assert finished.json["agents"] == ["bob/codex"]

    async def test_numbers_count_per_board(self, api: Api):
        one = await new_team(api)
        two = await new_team(api)
        assert (await add(api, one.alice, "a")).json["number"] == 1
        assert (await add(api, one.alice, "b")).json["number"] == 2
        assert (await add(api, two.alice, "c")).json["number"] == 1

    async def test_several_agents_work_on_one_task(self, api: Api):
        team = await new_team(api)
        await add(api, team.claude, "Checkout", take=True)
        both = await act(api, team.codex, 1, "take")
        assert both.json["agents"] == ["alice/claude", "bob/codex"]
        # Taking it again changes nothing.
        again = await act(api, team.codex, 1, "take")
        assert again.json["agents"] == ["alice/claude", "bob/codex"]

        left = await act(api, team.claude, 1, "leave")
        assert (left.json["state"], left.json["agents"]) == ("doing", ["bob/codex"])
        empty = await act(api, team.codex, 1, "leave")
        assert (empty.json["state"], empty.json["agents"]) == ("todo", [])
        refused = await act(api, team.codex, 1, "leave")
        assert refused.status == 422

    async def test_taking_a_finished_task_opens_it_again(self, api: Api):
        team = await new_team(api)
        await add(api, team.claude, "Fix", take=True)
        await act(api, team.claude, 1, "done")
        reopened = await act(api, team.codex, 1, "take")
        assert (reopened.json["state"], reopened.json["agents"]) == ("doing", ["bob/codex"])
        assert reopened.json["done_at"] is None

    async def test_list_by_state_and_unknown_tasks(self, api: Api):
        team = await new_team(api)
        await add(api, team.alice, "todo one")
        await add(api, team.claude, "doing one", take=True)
        everything = (await api.call("GET", "/v1/tasks", key=team.bob)).json["tasks"]
        assert [t["title"] for t in everything] == ["todo one", "doing one"]
        doing = (await api.call("GET", "/v1/tasks?state=doing", key=team.bob)).json["tasks"]
        assert [t["number"] for t in doing] == [2]
        assert (await act(api, team.claude, 99, "take")).status == 404
        assert (await add(api, team.alice, "   ")).status == 422

    async def test_changes_are_announced_on_the_board(self, api: Api):
        team = await new_team(api)
        await add(api, team.alice, "Rate-limit the webhook")
        await act(api, team.claude, 1, "take")
        await act(api, team.claude, 1, "leave")
        await add(api, team.codex, "Orders API", take=True)
        await act(api, team.codex, 2, "done")
        assert await board_events(api, team.bob) == [
            "alice added the task #1 Rate-limit the webhook.",
            "alice/claude took the task #1 Rate-limit the webhook.",
            "alice/claude left the task #1 Rate-limit the webhook.",
            "bob/codex added and took the task #2 Orders API.",
            "bob/codex finished the task #2 Orders API.",
        ]

    async def test_concurrent_takes_both_land(self, api: Api):
        team = await new_team(api)
        await add(api, team.alice, "Shared")
        results = await asyncio.gather(
            act(api, team.claude, 1, "take"), act(api, team.codex, 1, "take")
        )
        assert all(r.status == 200 for r in results)
        task = (await api.call("GET", "/v1/tasks", key=team.bob)).json["tasks"][0]
        assert sorted(task["agents"]) == ["alice/claude", "bob/codex"]

    async def test_the_feed_reads_tasks_with_a_read_token(self, api: Api):
        team = await new_team(api)
        await add(api, team.claude, "Checkout", take=True)
        listing = await api.call("GET", f"/v1/feed/tasks?token={team.read_token}")
        assert listing.status == 200
        assert [(t["number"], t["agents"]) for t in listing.json["tasks"]] == [
            (1, ["alice/claude"])
        ]
        assert (await api.call("GET", "/v1/feed/tasks?token=rd_nope")).status == 401

    async def test_a_title_is_kept_on_one_line(self, api: Api):
        team = await new_team(api)
        made = await add(api, team.alice, "  Fix\nthe   cart\t totals ", part=" web \n cart ")
        assert (made.json["title"], made.json["part"]) == ("Fix the cart totals", "web cart")
        assert await board_events(api, team.bob) == ["alice added the task #1 Fix the cart totals."]

    async def test_a_listing_carries_only_the_latest_finished_tasks(self, api: Api, monkeypatch):
        monkeypatch.setattr("hailboard_server.tasks.MAX_DONE_TASKS_LISTED", 2)
        team = await new_team(api)
        for title in ["one", "two", "three"]:
            task = (await add(api, team.claude, title, take=True)).json
            await act(api, team.claude, task["number"], "done")
        await add(api, team.alice, "open")
        listed = (await api.call("GET", "/v1/tasks", key=team.bob)).json["tasks"]
        assert [t["title"] for t in listed] == ["two", "three", "open"]
        # An older finished task can still be taken by its number.
        assert (await act(api, team.codex, 1, "take")).json["state"] == "doing"
