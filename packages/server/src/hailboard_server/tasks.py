"""Tasks: what the board works on, and which agents work on each."""

from typing import Any

from psycopg import AsyncConnection

from .schemas import MAX_DONE_TASKS_LISTED

_COLUMNS = """t.id, t.number, t.title, t.part, t.state, c.handle as created_by,
  t.created_at, t.updated_at, t.done_at,
  coalesce(
    (select array_agg(m.handle order by a.since, m.handle)
       from task_agents a join members m on m.board_id = a.board_id and m.id = a.member_id
      where a.task_id = t.id and m.state = 'active'),
    '{}'
  ) as agents"""
_FROM = "tasks t join members c on c.board_id = t.board_id and c.id = t.created_by"


async def list_tasks(
    conn: AsyncConnection, board_id: str, *, state: str | None = None
) -> list[dict[str, Any]]:
    """The board's tasks by number: every open one and the latest finished ones.

    Finished tasks pile up for as long as a board lives, and the web panel reads this list on
    every change, so only the `MAX_DONE_TASKS_LISTED` most recently finished are listed.
    """
    cur = await conn.execute(
        f"""select {_COLUMNS} from {_FROM}
             where t.board_id = %s and (%s::text is null or t.state = %s)
               and (t.state <> 'done' or t.id in (
                     select d.id from tasks d
                      where d.board_id = %s and d.state = 'done'
                      order by d.done_at desc, d.number desc
                      limit %s))
             order by t.number""",
        (board_id, state, state, board_id, MAX_DONE_TASKS_LISTED),
    )
    return await cur.fetchall()


async def get_task(conn: AsyncConnection, board_id: str, number: int) -> dict[str, Any] | None:
    cur = await conn.execute(
        f"select {_COLUMNS} from {_FROM} where t.board_id = %s and t.number = %s",
        (board_id, number),
    )
    return await cur.fetchone()


def public(task: dict[str, Any]) -> dict[str, Any]:
    """A task row without the internal id."""
    return {k: v for k, v in task.items() if k != "id"}


def label(task: dict[str, Any]) -> str:
    """How a task is named in a board event: "#3 Cart totals with discounts"."""
    title = task["title"]
    short = title if len(title) <= 80 else f"{title[:77]}..."
    return f"#{task['number']} {short}"
