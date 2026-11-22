import type { ReactNode } from "react";
import type { Board } from "./api.ts";
import { Mark } from "./Icon.tsx";
import { ACTIVITIES, type Activity, type AgentState, agentState, lastActive } from "./people.ts";
import { Picture } from "./pictures/Picture.tsx";
import type { MemberOut, Message, Task } from "./protocol.ts";
import type { Connection } from "./state.ts";
import { short } from "./text.ts";

const TITLES: Record<Activity, string> = {
  working: "Working",
  waiting: "Waiting",
  idle: "Idle",
  offline: "Offline",
};

/** The left column: the board and every agent on it, grouped by what it is doing. */
export function Sidebar({
  board,
  members,
  messages,
  tasks,
  connection,
  now,
}: {
  board: Board | null;
  members: MemberOut[];
  messages: Message[];
  /** The board's tasks, to show what each agent works on; null from a server without them. */
  tasks: Task[] | null;
  connection: Connection;
  now: number;
}) {
  const agents = members
    .filter((m) => m.kind === "agent")
    .map((member) => ({ member, state: agentState(member, messages, now) }));
  const people = members.filter((m) => m.kind === "human");

  return (
    <aside className="side">
      <div className="brand">
        <Mark />
        hailboard
      </div>

      <div className="group">
        <div className="group-title">
          <span>Board</span>
        </div>
        <div className="row on">
          <span className="board-mark">{(board?.name ?? "··").slice(0, 2)}</span>
          <span className="grow">{board?.name ?? "…"}</span>
          <span
            className={`board-live ${connection}`}
            title={connection === "live" ? "Live" : "Connecting…"}
          />
        </div>
      </div>

      <div className="group agents">
        <div className="group-title">
          <span>Agents</span>
          <span>{agents.length}</span>
        </div>
        {board !== null && agents.length === 0 && (
          <p className="side-empty">
            No agents yet. Invite a teammate with <code>hailboard invite</code>.
          </p>
        )}
        {ACTIVITIES.map((activity) => {
          const group = agents.filter((a) => a.state.activity === activity);
          if (group.length === 0) return null;
          return (
            <section key={activity} aria-label={TITLES[activity]}>
              <div className="state">
                <i className={`sdot ${activity}`} />
                {TITLES[activity]}
                <span>{group.length}</span>
              </div>
              {group.map(({ member, state }) => (
                <AgentRow
                  key={member.handle}
                  member={member}
                  state={state}
                  doing={doingOf(member.handle, tasks)}
                  now={now}
                />
              ))}
            </section>
          );
        })}
      </div>

      {people.length > 0 && (
        <div className="side-foot">
          <div className="group-title">
            <span>People</span>
            <span>{people.length}</span>
          </div>
          <div className="people">
            {people.map((p) => (
              <span key={p.handle} className={p.online ? "person" : "person away"}>
                <Picture handle={p.handle} small offline={!p.online} />
                {p.handle}
              </span>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

/** What an agent works on: the task(s) it is on, or null without tasks (its status line then). */
function doingOf(handle: string, tasks: Task[] | null): string | null {
  if (tasks === null) return null;
  const mine = tasks.filter((t) => t.state === "doing" && t.agents.includes(handle));
  if (mine.length === 0) return "No task taken";
  return mine.map((t) => `#${t.number} ${t.title}`).join(", ");
}

function AgentRow({
  member,
  state,
  doing,
  now,
}: {
  member: MemberOut;
  state: AgentState;
  /** The agent's task(s); null to fall back to its status line. */
  doing: string | null;
  now: number;
}) {
  const offline = state.activity === "offline";
  const what = doing ?? member.status_text;
  let sub: ReactNode = what ?? "";
  if (offline) {
    sub = member.last_seen_at
      ? `last seen ${short(member.last_seen_at, now)} ago`
      : "not connected yet";
  } else if (state.needsPerson) {
    sub = (
      <>
        <em className="ask">needs a person</em>
        {what ? ` · ${what}` : ""}
      </>
    );
  } else if (state.asked) {
    const to = state.asked.recipients.filter((r) => r !== member.handle);
    sub = (
      <>
        <em className="wait">asked #{state.asked.seq}</em>
        {what ? ` · ${what}` : to.length ? ` · ${to.join(", ")}` : ""}
      </>
    );
  }
  return (
    <div
      className={offline ? "row agent offline" : "row agent"}
      title={member.status_text ?? undefined}
    >
      <Picture handle={member.handle} offline={offline} />
      <span className="grow">
        <span className="main">{member.handle}</span>
        {sub && <span className="sub">{sub}</span>}
      </span>
      <span className="when">{short(offline ? member.last_seen_at : lastActive(member), now)}</span>
    </div>
  );
}
