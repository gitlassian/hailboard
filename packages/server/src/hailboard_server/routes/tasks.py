from typing import Annotated

from fastapi import APIRouter, Path, Request

from ..auth import CurrentMember, Pool
from ..errors import invalid, not_found
from ..joins import post_activity
from ..ratelimit import MESSAGES_PER_MEMBER, limiter
from ..schemas import MAX_OPEN_TASKS, AddTaskRequest, Task, TasksResponse, TaskState
from ..tasks import get_task, label, list_tasks, public

router = APIRouter()

Number = Annotated[int, Path(ge=1)]


@router.get("/tasks", response_model=TasksResponse)
async def tasks(member: CurrentMember, pool: Pool, state: TaskState | None = None):
    """The board's tasks by number, with the agents on each."""
    async with pool.connection() as conn:
        return {"tasks": [public(t) for t in await list_tasks(conn, member.board_id, state=state)]}


@router.post("/tasks", status_code=201, response_model=Task)
async def add(body: AddTaskRequest, request: Request, member: CurrentMember, pool: Pool):
    """Add a task. With `take` the caller starts on it at once. Announced on the board."""
    limiter(request).check(MESSAGES_PER_MEMBER, member.id, "messages from this member")
    async with pool.connection() as conn, conn.transaction():
        cur = await conn.execute(
            """update boards set last_task_number = last_task_number + 1
                where id = %s returning last_task_number""",
            (member.board_id,),
        )
        row = await cur.fetchone()
        assert row is not None
        cur = await conn.execute(
            "select count(*)::int as n from tasks where board_id = %s and state <> 'done'",
            (member.board_id,),
        )
        counted = await cur.fetchone()
        if counted and counted["n"] >= MAX_OPEN_TASKS:
            raise invalid(f"the board has {MAX_OPEN_TASKS} open tasks: finish some first")
        cur = await conn.execute(
            """insert into tasks (board_id, number, title, part, state, created_by)
               values (%s, %s, %s, %s, %s, %s) returning id""",
            (
                member.board_id,
                row["last_task_number"],
                body.title,
                body.part,
                "doing" if body.take else "todo",
                member.id,
            ),
        )
        created = await cur.fetchone()
        assert created is not None
        if body.take:
            await conn.execute(
                "insert into task_agents (task_id, board_id, member_id) values (%s, %s, %s)",
                (created["id"], member.board_id, member.id),
            )
        task = await get_task(conn, member.board_id, row["last_task_number"])
        assert task is not None
        verb = "added and took" if body.take else "added"
        await post_activity(
            conn, member.board_id, member.id, f"{member.handle} {verb} the task {label(task)}."
        )
    return public(task)


@router.post("/tasks/{number}/take", response_model=Task)
async def take(number: Number, request: Request, member: CurrentMember, pool: Pool):
    """Start on a task, next to anyone already on it. A finished task opens again."""
    limiter(request).check(MESSAGES_PER_MEMBER, member.id, "messages from this member")
    async with pool.connection() as conn, conn.transaction():
        task = await _locked(conn, member.board_id, number)
        if member.handle in task["agents"] and task["state"] == "doing":
            return public(task)
        reopened = task["state"] == "done"
        if reopened:
            # The ones who did it before are not on it now.
            await conn.execute("delete from task_agents where task_id = %s", (task["id"],))
        await conn.execute(
            """insert into task_agents (task_id, board_id, member_id) values (%s, %s, %s)
               on conflict do nothing""",
            (task["id"], member.board_id, member.id),
        )
        await conn.execute(
            """update tasks set state = 'doing', done_at = null, updated_at = now()
                where id = %s""",
            (task["id"],),
        )
        task = await get_task(conn, member.board_id, number)
        assert task is not None
        verb = "reopened and took" if reopened else "took"
        await post_activity(
            conn, member.board_id, member.id, f"{member.handle} {verb} the task {label(task)}."
        )
    return public(task)


@router.post("/tasks/{number}/leave", response_model=Task)
async def leave(number: Number, request: Request, member: CurrentMember, pool: Pool):
    """Stop working on a task. When nobody is left on it, it goes back to "todo"."""
    limiter(request).check(MESSAGES_PER_MEMBER, member.id, "messages from this member")
    async with pool.connection() as conn, conn.transaction():
        task = await _locked(conn, member.board_id, number)
        if member.handle not in task["agents"] or task["state"] != "doing":
            raise invalid(f"you are not working on task #{number}")
        await conn.execute(
            "delete from task_agents where task_id = %s and member_id = %s",
            (task["id"], member.id),
        )
        await conn.execute(
            """update tasks
                  set state = case when exists (select 1 from task_agents where task_id = %s)
                                   then 'doing' else 'todo' end,
                      updated_at = now()
                where id = %s""",
            (task["id"], task["id"]),
        )
        task = await get_task(conn, member.board_id, number)
        assert task is not None
        await post_activity(
            conn, member.board_id, member.id, f"{member.handle} left the task {label(task)}."
        )
    return public(task)


@router.post("/tasks/{number}/done", response_model=Task)
async def done(number: Number, request: Request, member: CurrentMember, pool: Pool):
    """Mark a task done. Whoever finishes it is counted among the ones who did it."""
    limiter(request).check(MESSAGES_PER_MEMBER, member.id, "messages from this member")
    async with pool.connection() as conn, conn.transaction():
        task = await _locked(conn, member.board_id, number)
        if task["state"] == "done":
            return public(task)
        await conn.execute(
            """insert into task_agents (task_id, board_id, member_id) values (%s, %s, %s)
               on conflict do nothing""",
            (task["id"], member.board_id, member.id),
        )
        await conn.execute(
            "update tasks set state = 'done', done_at = now(), updated_at = now() where id = %s",
            (task["id"],),
        )
        task = await get_task(conn, member.board_id, number)
        assert task is not None
        await post_activity(
            conn, member.board_id, member.id, f"{member.handle} finished the task {label(task)}."
        )
    return public(task)


async def _locked(conn, board_id: str, number: int):
    """The task, locked for the rest of the transaction so two changes cannot cross."""
    cur = await conn.execute(
        "select id from tasks where board_id = %s and number = %s for update",
        (board_id, number),
    )
    if await cur.fetchone() is None:
        raise not_found(f"no task #{number}")
    task = await get_task(conn, board_id, number)
    assert task is not None
    return task
