import { Fragment, useContext } from "react";
import {
  agentTiles,
  boardTalks,
  daySummary,
  type TaskGroup,
  taskGroups,
  weightOf,
} from "./board.ts";
import { CutBoard, type Piece, type Talk, type Tone } from "./CutBoard.tsx";
import { MAX_PIECES } from "./cutboard.ts";
import { jumpTo } from "./jump.ts";
import { lastActive, lookOf } from "./people.ts";
import { LooksContext } from "./pictures/Picture.tsx";
import type { MemberOut, Message, Task } from "./protocol.ts";
import { between, short, splitBody } from "./text.ts";

/** The chip of a piece: the most urgent state among its agents. */
function chipOf(group: TaskGroup): { label: string; tone: Tone } {
  if (group.tiles.length === 0) return { label: "in progress", tone: "ok" };
  const states = group.tiles.map((t) => t.state);
  if (states.some((s) => s.needsPerson)) return { label: "needs a person", tone: "ask" };
  if (states.some((s) => s.activity === "waiting")) return { label: "waiting", tone: "wait" };
  if (states.some((s) => s.activity === "working")) return { label: "working", tone: "ok" };
  if (states.some((s) => s.activity === "idle")) return { label: "idle", tone: "" };
  return { label: "offline", tone: "" };
}

/** Who is doing what right now: one piece per task, sized by the agents on it, with arrows for
 * the conversations between them. The numbers of the last day stand in the heading. */
export function BoardPane({
  members,
  messages,
  tasks,
  loaded,
  now,
}: {
  members: MemberOut[];
  messages: Message[];
  /** The board's tasks; null from a server without them. */
  tasks: Task[] | null;
  loaded: boolean;
  now: number;
}) {
  const looks = useContext(LooksContext);
  const tiles = agentTiles(members, messages, now);
  const groups = taskGroups(tiles, tasks);
  const day = daySummary(messages, now);

  const pieces: Piece[] = groups.map((g) => {
    const lead = g.tiles[0]?.member.handle ?? g.people[0] ?? g.title;
    const latest = g.tiles
      .map((t) => t.last)
      .filter((m): m is Message => m !== null)
      .sort((a, b) => b.seq - a.seq)[0];
    const needs = g.tiles.find((t) => t.state.needsPerson)?.state.needsPerson;
    const asking = g.tiles.find((t) => t.state.asked);
    const free = g.tiles.length > 0 && g.tiles.every((t) => t.state.activity === "offline");
    let doing: Piece["doing"] = null;
    if (needs) doing = `Waits for a person · #${needs.seq} · ${between(needs.created_at, now)}`;
    else if (asking?.state.asked) {
      const to = asking.state.asked.recipients.filter((r) => r !== asking.member.handle);
      doing = `Asked ${to.join(", ")} · #${asking.state.asked.seq}`;
    } else if (g.task) doing = `Task #${g.task.number}${g.task.part ? ` · ${g.task.part}` : ""}`;
    else if (tasks !== null) doing = "No task taken";
    // When somebody last worked on it: the agents' latest activity, or for a task that only
    // people are on, its last change.
    const active = g.tiles
      .map((t) => lastActive(t.member))
      .filter((s): s is string => s !== null)
      .sort((a, b) => Date.parse(a) - Date.parse(b))
      .at(-1);
    const when = active ?? (g.tiles.length === 0 ? g.task?.updated_at : undefined);
    return {
      key: g.key,
      colour: `p${lookOf(lead, looks).colour}`,
      free,
      weight: weightOf(g),
      title: g.title,
      chip: chipOf(g),
      doing,
      desc: latest ? <Body text={latest.body} /> : "Has not written yet.",
      who: [
        ...g.tiles.map((t) => ({
          handle: t.member.handle,
          offline: t.state.activity === "offline",
        })),
        ...g.people.map((handle) => ({ handle, offline: false })),
      ],
      when: when ? short(when, now) : "never seen",
      onClick: latest ? () => jumpTo(latest.seq) : undefined,
    };
  });

  // The sheet has room for so many pieces; the biggest and most active come first.
  const shown = pieces.slice(0, MAX_PIECES);
  const hidden = pieces.length - shown.length;

  const talks: Talk[] = boardTalks(groups, messages, now).map((t) => ({
    from: t.from,
    to: t.to,
    state: t.state,
    label: `#${t.seq} ${t.state === "asking" ? "asks" : "answered"}`,
  }));

  return (
    <div className="pane">
      <div className="card-head">
        <span>Board</span>
        {loaded && (
          <span className="r" title="The last 24 hours on this board">
            Last 24 hours: <b>{day.messages}</b> {day.messages === 1 ? "message" : "messages"} ·{" "}
            <b>{day.questions}</b> {day.questions === 1 ? "question" : "questions"} ·{" "}
            <b>{day.answered}</b> answered
          </span>
        )}
      </div>
      <div className="scroll board-scroll">
        {!loaded && <p className="pane-note">Loading…</p>}
        {loaded &&
          (pieces.length === 0 ? (
            <p className="pane-note">
              No agents on this board yet. Invite a teammate with <code>hailboard invite</code>.
            </p>
          ) : (
            <CutBoard pieces={shown} talks={talks} />
          ))}
        {loaded && hidden > 0 && (
          <p className="pane-note small">
            {hidden} more {hidden === 1 ? "piece does" : "pieces do"} not fit on the board. Every
            agent is in the list on the left.
          </p>
        )}
      </div>
    </div>
  );
}

/** A message body in a piece: plain text with `code` shown as code. */
function Body({ text }: { text: string }) {
  return (
    <>
      {splitBody(text).map((s, i) =>
        // biome-ignore lint/suspicious/noArrayIndexKey: segments of one immutable message
        "code" in s ? <code key={i}>{s.code}</code> : <Fragment key={i}>{s.text}</Fragment>,
      )}
    </>
  );
}
