import type { DocumentInfo, MemberOut, Message, Task } from "./protocol.ts";

export type Connection = "connecting" | "live" | "reconnecting";

export interface FeedState {
  /** Loaded messages, oldest first, one per number. */
  messages: Message[];
  members: MemberOut[];
  /** The board's tasks by number; null while unknown or from a server without tasks. */
  tasks: Task[] | null;
  /** No older messages exist than the first loaded one. */
  reachedStart: boolean;
  connection: Connection;
}

export type FeedAction =
  | { type: "loaded"; messages: Message[]; members: MemberOut[]; pageSize: number }
  | { type: "older"; messages: Message[]; pageSize: number }
  | { type: "message"; message: Message }
  | { type: "member"; member: MemberOut }
  | { type: "tasks"; tasks: Task[] | null }
  | { type: "task"; task: Task }
  | { type: "connection"; connection: Connection };

export const initialState: FeedState = {
  messages: [],
  members: [],
  tasks: null,
  reachedStart: false,
  connection: "connecting",
};

/** Merges messages by number, keeping the order. The newer copy of a number wins. */
export function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return current;
  const last = current.at(-1);
  const only = incoming.length === 1 ? incoming[0] : undefined;
  // The common case: one live message after everything we have.
  if (only && (last === undefined || only.seq > last.seq)) return [...current, only];
  const bySeq = new Map<number, Message>();
  for (const m of current) bySeq.set(m.seq, m);
  for (const m of incoming) bySeq.set(m.seq, m);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Members sorted so that each person is followed by their agents: alice, alice/claude, bob... */
export function upsertMember(members: MemberOut[], member: MemberOut): MemberOut[] {
  const rest = members.filter((m) => m.handle !== member.handle);
  return sortMembers([...rest, member]);
}

export function sortMembers(members: MemberOut[]): MemberOut[] {
  return [...members].sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
}

/** Puts a task in its place by number; a newer copy of the same number replaces the old one. */
export function upsertTask(tasks: Task[], task: Task): Task[] {
  return [...tasks.filter((t) => t.number !== task.number), task].sort(
    (a, b) => a.number - b.number,
  );
}

export function feedReducer(state: FeedState, action: FeedAction): FeedState {
  switch (action.type) {
    case "loaded":
      return {
        ...state,
        // Live events may already have arrived; keep them.
        messages: mergeMessages(action.messages, state.messages),
        members: sortMembers(action.members),
        reachedStart: action.messages.length < action.pageSize,
      };
    case "older":
      return {
        ...state,
        messages: mergeMessages(state.messages, action.messages),
        reachedStart: action.messages.length < action.pageSize,
      };
    case "message":
      return { ...state, messages: mergeMessages(state.messages, [action.message]) };
    case "member":
      return { ...state, members: upsertMember(state.members, action.member) };
    case "tasks":
      return { ...state, tasks: action.tasks };
    case "task":
      return { ...state, tasks: upsertTask(state.tasks ?? [], action.task) };
    case "connection":
      return state.connection === action.connection
        ? state
        : { ...state, connection: action.connection };
  }
}

/** A message that asks a person for something: `--ask`, or addressed to @human. */
export function asksHuman(message: Message): boolean {
  return message.kind === "human_request" || message.mention_humans;
}

// A question mark that ends a phrase: "which port?", "(the order id?)", not "/orders?cursor=".
const QUESTION_MARK = /[?？؟](?=$|[\s)"'»”\]])/m;

/**
 * A question from one member to others: addressed to somebody else, not meant for a person, and
 * worded as a question. "@bob the endpoint is ready" is news, not a question, and nobody waits
 * for an answer to it. Inline code and links are not looked at.
 */
export function asksMembers(message: Message): boolean {
  if (message.kind !== "message" || asksHuman(message)) return false;
  if (!message.recipients.some((r) => r !== message.from)) return false;
  const text = message.body.replace(/`[^`\n]*`/g, "").replace(/https?:\/\/\S+/g, "");
  return QUESTION_MARK.test(text);
}

/**
 * Requests for a human that nobody has replied to yet (among the loaded messages), newest first.
 * A reply is any later message with `reply_to` pointing at the request.
 */
export function openHumanRequests(messages: Message[]): Message[] {
  const answered = new Set<number>();
  for (const m of messages) if (m.reply_to !== null) answered.add(m.reply_to);
  return messages.filter((m) => asksHuman(m) && !answered.has(m.seq)).reverse();
}

/** The people a request names (`@alice`), or an empty list when it is for anyone on the team. */
export function expectedAnswerers(message: Message): string[] {
  return message.mentions.filter((handle) => !handle.includes("/"));
}

/**
 * What a person tells their own agent to answer a request. Pasted into the agent's chat, followed
 * by the answer; the agent posts it as a reply on the board.
 */
export function replyPrompt(seq: number): string {
  return `Reply to #${seq} on the hailboard board: `;
}

/** Number of replies each loaded message received. */
export function replyCounts(messages: Message[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const m of messages) {
    if (m.reply_to !== null) counts.set(m.reply_to, (counts.get(m.reply_to) ?? 0) + 1);
  }
  return counts;
}

/** Who a message is addressed to, for the "from → to" line. */
export function recipients(message: Message): string[] {
  const out = message.mentions.map((h) => `@${h}`);
  if (message.mention_all) out.unshift("@all");
  if (message.mention_humans) out.push("@human");
  return out;
}

/**
 * Who a message has reached and who not yet. The server says who had seen it when the message was
 * loaded; the members' read cursors (sent again whenever one moves) bring that up to date live.
 */
export function receipts(
  message: Message,
  members: MemberOut[],
): { seen: string[]; waiting: string[] } {
  const readUpTo = new Map(members.map((m) => [m.handle, m.read_up_to]));
  const seen: string[] = [];
  const waiting: string[] = [];
  for (const handle of message.recipients) {
    const reached = message.seen_by.includes(handle) || (readUpTo.get(handle) ?? 0) >= message.seq;
    (reached ? seen : waiting).push(handle);
  }
  return { seen, waiting };
}

/** The pinned document first (every agent gets it when a session starts), then by name. */
export function orderDocuments(list: DocumentInfo[]): DocumentInfo[] {
  return [...list].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}
