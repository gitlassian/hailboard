import { ACTIVITIES, type AgentState, agentState } from "./people.ts";
import type { MemberOut, Message, Task } from "./protocol.ts";
import { asksMembers } from "./state.ts";

const DAY_MS = 24 * 60 * 60_000;

/** What a tile on the board shows about one agent. */
export interface AgentTile {
  member: MemberOut;
  state: AgentState;
  /** The agent's latest message, not counting board events. */
  last: Message | null;
  /** Messages the agent wrote in the last 24 hours. */
  today: number;
  /** Who the agent talks with most, by messages between them, most first (up to three). */
  partners: string[];
}

const said = (m: Message) => m.kind !== "activity";

/** The other side of a message: who it was addressed to, without the author. */
function others(m: Message): string[] {
  return m.recipients.filter((r) => r !== m.from);
}

/** One tile per agent, working agents first, then waiting, idle and offline; by name inside. */
export function agentTiles(members: MemberOut[], messages: Message[], now: number): AgentTile[] {
  const tiles = members
    .filter((m) => m.kind === "agent")
    .map((member) => {
      const mine = messages.filter((m) => m.from === member.handle && said(m));
      const talk = new Map<string, number>();
      for (const m of messages) {
        if (!said(m)) continue;
        if (m.from === member.handle)
          for (const r of others(m)) talk.set(r, (talk.get(r) ?? 0) + 1);
        else if (m.recipients.includes(member.handle))
          talk.set(m.from, (talk.get(m.from) ?? 0) + 1);
      }
      const partners = [...talk.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, 3)
        .map(([h]) => h);
      return {
        member,
        state: agentState(member, messages, now),
        last: mine.at(-1) ?? null,
        today: mine.filter((m) => now - Date.parse(m.created_at) <= DAY_MS).length,
        partners,
      };
    });
  const rank = (t: AgentTile) => ACTIVITIES.indexOf(t.state.activity);
  return tiles.sort((a, b) => rank(a) - rank(b) || (a.member.handle < b.member.handle ? -1 : 1));
}

/** A question from one member to others and what became of it. */
export interface Thread {
  question: Message;
  /** The reply, or the first later message from someone it was addressed to. */
  answer: Message | null;
}

/**
 * The latest questions between members, newest first (see `asksMembers` for what counts as one).
 * A question counts as answered by a reply to it, or by the next message any addressee wrote
 * afterwards.
 */
export function recentThreads(messages: Message[], limit = 8): Thread[] {
  const out: Thread[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const q = messages[i] as Message;
    if (!asksMembers(q)) continue;
    const to = others(q);
    let answer: Message | null = null;
    for (let j = i + 1; j < messages.length; j++) {
      const m = messages[j] as Message;
      if (!said(m)) continue;
      if (m.reply_to === q.seq || to.includes(m.from)) {
        answer = m;
        break;
      }
    }
    out.push({ question: q, answer });
  }
  return out;
}

/** Numbers for the line on top of the board, over the last 24 hours. */
export interface DaySummary {
  messages: number;
  questions: number;
  answered: number;
  /** Median minutes from a question to its answer, null without answered questions. */
  medianAnswerMinutes: number | null;
  documents: number;
}

export function daySummary(messages: Message[], now: number): DaySummary {
  const recent = messages.filter((m) => now - Date.parse(m.created_at) <= DAY_MS);
  const threads = recentThreads(recent, Number.POSITIVE_INFINITY);
  const delays = threads
    .filter((t) => t.answer)
    .map(
      (t) =>
        (Date.parse((t.answer as Message).created_at) - Date.parse(t.question.created_at)) / 60_000,
    )
    .sort((a, b) => a - b);
  const mid = delays.length ? (delays[Math.floor((delays.length - 1) / 2)] as number) : null;
  return {
    messages: recent.filter(said).length,
    questions: threads.length,
    answered: threads.filter((t) => t.answer).length,
    medianAnswerMinutes: mid === null ? null : Math.max(0, Math.round(mid)),
    // Board events about documents: "alice added the document plan.md", "… updated the document …".
    documents: recent.filter(
      (m) => m.kind === "activity" && /\b(added|updated) the document\b/.test(m.body),
    ).length,
  };
}

/** A piece of the board: one task and the agents on it. */
export interface TaskGroup {
  key: string;
  /** The task's title, or the agent's handle when it has no task. */
  title: string;
  /** The board's task behind the piece; null for an agent without a task, or a status line. */
  task: Task | null;
  hasTask: boolean;
  /** The agents on it. */
  tiles: AgentTile[];
  /** People (not agents) on the task. */
  people: string[];
}

/**
 * The pieces of the board. With the board's tasks, every task in progress is a piece holding the
 * agents on it, and every agent on no task gets a piece of its own. Without tasks (an older
 * server) an agent's status line stands in for its task: agents with the same one share a piece.
 * Bigger groups first, then by how active they are.
 */
export function taskGroups(tiles: AgentTile[], tasks: Task[] | null = null): TaskGroup[] {
  const groups: TaskGroup[] = [];
  if (tasks !== null) {
    const byHandle = new Map(tiles.map((t) => [t.member.handle, t]));
    const busy = new Set<string>();
    for (const task of tasks) {
      if (task.state !== "doing") continue;
      const on = task.agents.map((h) => byHandle.get(h)).filter((t): t is AgentTile => !!t);
      const people = task.agents.filter((h) => !byHandle.has(h));
      for (const t of on) busy.add(t.member.handle);
      groups.push({
        key: `task:${task.number}`,
        title: task.title,
        task,
        hasTask: true,
        tiles: on,
        people,
      });
    }
    for (const t of tiles) {
      if (busy.has(t.member.handle)) continue;
      groups.push({
        key: `agent:${t.member.handle}`,
        title: t.member.handle,
        task: null,
        hasTask: false,
        tiles: [t],
        people: [],
      });
    }
  } else {
    const byStatus = new Map<string, TaskGroup>();
    for (const t of tiles) {
      const status = t.member.status_text?.trim();
      const key = status ? `status:${status.toLowerCase()}` : `agent:${t.member.handle}`;
      const group = byStatus.get(key);
      if (group) group.tiles.push(t);
      else {
        const made: TaskGroup = {
          key,
          title: status || t.member.handle,
          task: null,
          hasTask: !!status,
          tiles: [t],
          people: [],
        };
        byStatus.set(key, made);
        groups.push(made);
      }
    }
  }
  const rank = (g: TaskGroup) =>
    g.tiles.length ? Math.min(...g.tiles.map((t) => ACTIVITIES.indexOf(t.state.activity))) : 0;
  return groups.sort(
    (a, b) =>
      weightOf(b) - weightOf(a) ||
      rank(a) - rank(b) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

/** How much of the board a piece gets: the number of agents on it, at least one. */
export function weightOf(group: TaskGroup): number {
  return Math.max(1, group.tiles.length);
}

/** An arrow on the board: who asks whom now, or who answered whom recently. */
export interface BoardTalk {
  from: string;
  to: string;
  seq: number;
  state: "asking" | "answered";
}

/** Answers older than this are not drawn. */
const ANSWERED_MS = DAY_MS;

/**
 * The conversations worth an arrow between pieces: every open question an agent waits on, and the
 * two latest answered ones, from the piece of whoever asked to the piece of whoever answers.
 * Only pairs of different pieces, at most three arrows.
 */
export function boardTalks(groups: TaskGroup[], messages: Message[], now: number): BoardTalk[] {
  const pieceOf = new Map<string, string>();
  for (const g of groups) for (const t of g.tiles) pieceOf.set(t.member.handle, g.key);
  const out: BoardTalk[] = [];
  const seen = new Set<string>();
  const add = (fromHandle: string, toHandle: string, seq: number, state: BoardTalk["state"]) => {
    const from = pieceOf.get(fromHandle);
    const to = pieceOf.get(toHandle);
    if (!from || !to || from === to) return;
    const pair = `${from}>${to}`;
    if (seen.has(pair) || out.length >= 3) return;
    seen.add(pair);
    out.push({ from, to, seq, state });
  };
  for (const g of groups) {
    for (const t of g.tiles) {
      const asked = t.state.asked;
      if (!asked) continue;
      const to = asked.recipients.find((r) => r !== t.member.handle && pieceOf.has(r));
      if (to) add(t.member.handle, to, asked.seq, "asking");
    }
  }
  let answered = 0;
  for (const thread of recentThreads(messages, 20)) {
    if (answered >= 2) break;
    const a = thread.answer;
    if (!a || now - Date.parse(a.created_at) > ANSWERED_MS) continue;
    const before = out.length;
    add(thread.question.from, a.from, thread.question.seq, "answered");
    if (out.length > before) answered++;
  }
  return out;
}
