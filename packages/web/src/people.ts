import type { MemberOut, Message } from "./protocol.ts";
import { asksHuman, asksMembers } from "./state.ts";

/** The person a handle belongs to: "alice/claude" → "alice", "alice" → "alice". */
export function ownerOf(handle: string): string {
  return handle.split("/")[0] ?? handle;
}

/** The agent part of a handle: "alice/claude" → "claude", "alice" → null. */
export function agentOf(handle: string): string | null {
  const at = handle.indexOf("/");
  return at < 0 ? null : handle.slice(at + 1);
}

export const SHAPES = ["flower", "squircle", "triangle", "star"] as const;
export type Shape = (typeof SHAPES)[number];
export const COLOURS = 6;

/** How a person is drawn: a shape and one of the person colours (`--p0`…`--p5`). */
export interface Look {
  shape: Shape;
  colour: number;
}

function hash(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/**
 * Gives every person on the board a look. People are taken in the order they joined, so the first
 * people on a board never share a shape or a colour and a person keeps their look when others
 * join later. Agents use the look of their person.
 */
export function assignLooks(members: MemberOut[]): Map<string, Look> {
  const people = members
    .filter((m) => m.kind === "human")
    .sort(
      (a, b) => Date.parse(a.joined_at) - Date.parse(b.joined_at) || (a.handle < b.handle ? -1 : 1),
    );
  const looks = new Map<string, Look>();
  people.forEach((p, i) => {
    looks.set(p.handle, { shape: SHAPES[i % SHAPES.length] as Shape, colour: i % COLOURS });
  });
  return looks;
}

/** The look of the person behind a handle. Someone not on the list gets one from their name. */
export function lookOf(handle: string, looks: Map<string, Look>): Look {
  const owner = ownerOf(handle);
  const known = looks.get(owner);
  if (known) return known;
  const h = hash(owner);
  return { shape: SHAPES[h % SHAPES.length] as Shape, colour: (h >>> 3) % COLOURS };
}

/**
 * When a member last did something. A newer server reports it apart from "last seen", which also
 * moves while an agent only waits for messages; an older one has "last seen" alone.
 */
export function lastActive(member: MemberOut): string | null {
  return member.last_active_at ?? member.last_seen_at;
}

/** What an agent is doing, for the groups in the sidebar. */
export type Activity = "working" | "waiting" | "idle" | "offline";
export const ACTIVITIES: Activity[] = ["working", "waiting", "idle", "offline"];

/** An agent counts as working this long after its last step of work. */
export const ACTIVE_MS = 3 * 60_000;
/** A question an agent asked counts as open for this long without an answer. */
export const WAITING_MS = 30 * 60_000;

export interface AgentState {
  activity: Activity;
  /** The open question this agent asked another agent, if it waits for an answer. */
  asked: Message | null;
  /** The open question this agent asked a person. */
  needsPerson: Message | null;
}

/**
 * Where an agent is, worked out from what the board already has: whether it is connected, when it
 * last did something other than wait for messages, and its own questions. An agent waits when its
 * latest message asked other members something, none of them has written since, and the question
 * is not older than `WAITING_MS`. A question for a person stays open until somebody replies to it,
 * however old it is.
 */
export function agentState(member: MemberOut, messages: Message[], now: number): AgentState {
  let latest: Message | null = null;
  let needsPerson: Message | null = null;
  const answered = new Set<number>();
  for (const m of messages) if (m.reply_to !== null) answered.add(m.reply_to);

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Message;
    if (m.from !== member.handle || m.kind === "activity") continue;
    if (latest === null) latest = m;
    if (asksHuman(m) && !answered.has(m.seq)) {
      needsPerson = m;
      break;
    }
  }

  let asked: Message | null = null;
  if (latest && asksMembers(latest) && now - Date.parse(latest.created_at) <= WAITING_MS) {
    const question = latest;
    const addressed = question.recipients.filter((r) => r !== member.handle);
    const replied =
      answered.has(question.seq) ||
      messages.some(
        (m) => m.seq > question.seq && addressed.includes(m.from) && m.kind !== "activity",
      );
    if (!replied) asked = question;
  }

  // A connected agent works while it did something lately; one that only waits for messages is
  // idle. A server that does not report activity (older) leaves every connected agent working.
  let activity: Activity;
  if (!member.online) activity = "offline";
  else if (asked) activity = "waiting";
  else if (member.last_active_at === undefined) activity = "working";
  else if (member.last_active_at && now - Date.parse(member.last_active_at) <= ACTIVE_MS)
    activity = "working";
  else activity = "idle";

  return { activity, asked, needsPerson };
}
