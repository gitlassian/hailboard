import { useState } from "react";
import { Icon } from "./Icon.tsx";
import { agentState } from "./people.ts";
import { Identity, Picture } from "./pictures/Picture.tsx";
import type { MemberOut, Message, Task, TaskState } from "./protocol.ts";
import { Segmented } from "./Segmented.tsx";
import { short, stamp } from "./text.ts";

const COLUMNS: { state: TaskState; title: string }[] = [
  { state: "todo", title: "To do" },
  { state: "doing", title: "In progress" },
  { state: "done", title: "Done" },
];

/** The choice that shows every part; parts themselves are "p:<name>", so no name can meet it. */
const ALL = "all";

const STATE_TITLES: Record<TaskState, string> = {
  todo: "To do",
  doing: "In progress",
  done: "Done",
};

/** Every task on the board in three columns, with a filter by part of the project. */
export function TasksPane({
  tasks: loaded,
  members,
  messages,
  now,
}: {
  /** Null while the board is loading. */
  tasks: Task[] | null;
  members: MemberOut[];
  messages: Message[];
  now: number;
}) {
  const [part, setPart] = useState<string | null>(null);
  const tasks = loaded ?? [];
  const parts = [...new Set(tasks.map((t) => t.part).filter((p): p is string => !!p))].sort();
  // A chosen part can disappear with its last task: then everything is shown again.
  const chosen = part !== null && parts.includes(part) ? part : null;
  const shown = chosen === null ? tasks : tasks.filter((t) => t.part === chosen);
  const byHandle = new Map(members.map((m) => [m.handle, m]));

  return (
    <div className="pane">
      <div className="card-head">
        <span>Tasks</span>
        {parts.length > 0 && (
          <span className="head-mid">
            <Segmented
              label="Part of the project"
              value={chosen === null ? ALL : `p:${chosen}`}
              onChange={(v) => setPart(v === ALL ? null : v.slice(2))}
              choices={[
                { value: ALL, label: "All parts" },
                ...parts.map((p) => ({ value: `p:${p}`, label: p })),
              ]}
            />
          </span>
        )}
        <span className="r">{tasks.filter((t) => t.state !== "done").length} open</span>
      </div>
      <div className="scroll tasks-scroll">
        {loaded === null ? (
          <p className="pane-note">Loading…</p>
        ) : tasks.length === 0 ? (
          <div className="pane-note">
            <p>No tasks yet.</p>
            <p>
              Agents add and take them with <code>hailboard task add "title" --take</code> or the
              MCP <code>task</code> tool, and mark them done when they finish.
            </p>
          </div>
        ) : (
          <div className="columns">
            {COLUMNS.map((col) => {
              const list = shown
                .filter((t) => t.state === col.state)
                .sort((a, b) =>
                  col.state === "done"
                    ? Date.parse(b.done_at ?? b.updated_at) - Date.parse(a.done_at ?? a.updated_at)
                    : a.number - b.number,
                );
              return (
                <section key={col.state} className="column" aria-label={col.title}>
                  <div className="column-head">
                    <span>{col.title}</span>
                    <span>{list.length}</span>
                  </div>
                  {list.length === 0 && (
                    <p className="column-none">
                      {chosen === null ? "Nothing here" : "Nothing here for this part"}
                    </p>
                  )}
                  {list.map((t) => (
                    <TaskCard
                      key={t.number}
                      task={t}
                      members={byHandle}
                      messages={messages}
                      now={now}
                    />
                  ))}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function TaskCard({
  task,
  members,
  messages,
  now,
}: {
  task: Task;
  members: Map<string, MemberOut>;
  messages: Message[];
  now: number;
}) {
  // A dot when an agent on the task waits for an answer or for a person.
  let flag: "wait" | "ask" | null = null;
  if (task.state === "doing") {
    for (const handle of task.agents) {
      const member = members.get(handle);
      if (member?.kind !== "agent") continue;
      const state = agentState(member, messages, now);
      if (state.needsPerson) flag = "ask";
      else if (state.asked && flag === null) flag = "wait";
    }
  }
  const added = short(task.created_at, now);
  const when =
    task.state === "done"
      ? stamp(task.done_at ?? task.updated_at, now)
      : task.state === "doing"
        ? short(task.updated_at, now)
        : added === "now"
          ? "added just now"
          : `added ${added} ago`;
  const taken = task.agents.length > 0;

  return (
    <article className={`task ${task.state}`}>
      <div className="task-top">
        <span className={`st ${task.state}`} title={STATE_TITLES[task.state]}>
          {task.state === "done" && <Icon name="check" className="st-check" />}
        </span>
        <span className="task-title" title={task.title}>
          {task.title}
        </span>
        {flag && (
          <span
            className={`task-flag ${flag}`}
            title={flag === "ask" ? "needs a person" : "waiting for an answer"}
          />
        )}
      </div>
      {/* The picture hangs in the left column under the state mark, so the title, the name and
          the last line all start at one x. */}
      {taken ? (
        <div className="task-meta">
          {task.agents.length === 1 ? (
            <Identity handle={task.agents[0] as string} small />
          ) : (
            <span className="pics">
              {task.agents.map((h) => (
                <Picture key={h} handle={h} small />
              ))}
            </span>
          )}
          <span className="task-when">{when}</span>
        </div>
      ) : (
        <div className="task-meta bare">
          <span className="task-added">{when}</span>
          <span className="task-when">
            from <Picture handle={task.created_by} small />
          </span>
        </div>
      )}
      <div className="task-foot">
        #{task.number}
        {task.part ? ` · ${task.part}` : ""}
      </div>
    </article>
  );
}
