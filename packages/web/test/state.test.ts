import { describe, expect, it } from "vitest";
import type { DocumentInfo, MemberOut, Message } from "../src/protocol.ts";
import {
  asksMembers,
  expectedAnswerers,
  feedReducer,
  initialState,
  mergeMessages,
  openHumanRequests,
  orderDocuments,
  receipts,
  recipients,
  replyCounts,
  replyPrompt,
} from "../src/state.ts";

function msg(seq: number, extra: Partial<Message> = {}): Message {
  return {
    seq,
    from: "alice/claude",
    kind: "message",
    body: `m${seq}`,
    mentions: [],
    recipients: [],
    seen_by: [],
    mention_all: false,
    mention_humans: false,
    reply_to: null,
    created_at: "2026-11-06T10:00:00Z",
    ...extra,
  };
}

function member(handle: string, extra: Partial<MemberOut> = {}): MemberOut {
  return {
    handle,
    kind: handle.includes("/") ? "agent" : "human",
    status_text: null,
    last_seen_at: null,
    last_active_at: null,
    joined_at: "2026-11-06T09:00:00Z",
    read_up_to: 0,
    online: false,
    ...extra,
  };
}

const seqs = (ms: Message[]) => ms.map((m) => m.seq);

describe("mergeMessages", () => {
  it("appends a newer message", () => {
    expect(seqs(mergeMessages([msg(1), msg(2)], [msg(3)]))).toEqual([1, 2, 3]);
  });

  it("puts older pages in front and drops duplicates", () => {
    expect(seqs(mergeMessages([msg(3), msg(4)], [msg(1), msg(2), msg(3)]))).toEqual([1, 2, 3, 4]);
  });

  it("ignores a message it already has", () => {
    expect(seqs(mergeMessages([msg(1), msg(2)], [msg(2)]))).toEqual([1, 2]);
  });
});

describe("feedReducer", () => {
  it("keeps live messages that arrived before the history finished loading", () => {
    let s = feedReducer(initialState, { type: "message", message: msg(5) });
    s = feedReducer(s, { type: "loaded", messages: [msg(3), msg(4)], members: [], pageSize: 100 });
    expect(seqs(s.messages)).toEqual([3, 4, 5]);
  });

  it("knows when the start of the board was reached", () => {
    const full = Array.from({ length: 3 }, (_, i) => msg(i + 10));
    let s = feedReducer(initialState, { type: "loaded", messages: full, members: [], pageSize: 3 });
    expect(s.reachedStart).toBe(false);
    s = feedReducer(s, { type: "older", messages: [msg(8), msg(9)], pageSize: 3 });
    expect(s.reachedStart).toBe(true);
    expect(seqs(s.messages)).toEqual([8, 9, 10, 11, 12]);
  });

  it("updates a member in place and keeps people next to their agents", () => {
    let s = feedReducer(initialState, {
      type: "loaded",
      messages: [],
      members: [member("bob"), member("alice/claude"), member("alice")],
      pageSize: 100,
    });
    s = feedReducer(s, {
      type: "member",
      member: member("alice/claude", { status_text: "tests" }),
    });
    s = feedReducer(s, { type: "member", member: member("bob/codex") });
    expect(s.members.map((m) => m.handle)).toEqual(["alice", "alice/claude", "bob", "bob/codex"]);
    expect(s.members[1]?.status_text).toBe("tests");
  });

  it("returns the same state when the connection did not change", () => {
    const s = feedReducer(initialState, { type: "connection", connection: "connecting" });
    expect(s).toBe(initialState);
  });
});

describe("openHumanRequests", () => {
  it("lists unanswered asks and @human mentions, newest first", () => {
    const messages = [
      msg(1, { kind: "human_request" }),
      msg(2, { mention_humans: true }),
      msg(3, { reply_to: 1 }),
      msg(4),
      msg(5, { kind: "human_request" }),
    ];
    expect(seqs(openHumanRequests(messages))).toEqual([5, 2]);
  });
});

describe("replyCounts and recipients", () => {
  it("counts replies per message", () => {
    const counts = replyCounts([msg(1), msg(2, { reply_to: 1 }), msg(3, { reply_to: 1 })]);
    expect(counts.get(1)).toBe(2);
    expect(counts.get(2)).toBeUndefined();
  });

  it("lists who a message is for", () => {
    const m = msg(1, { mentions: ["bob/codex"], mention_all: true, mention_humans: true });
    expect(recipients(m)).toEqual(["@all", "@bob/codex", "@human"]);
  });
});

describe("answering a request for a human", () => {
  const ask = (over: Partial<Message>): Message => ({ ...msg(1), ...over });

  it("names the people a request is for, or nobody when it is for the whole team", () => {
    expect(expectedAnswerers(ask({ mentions: ["alice", "bob/codex"] }))).toEqual(["alice"]);
    expect(expectedAnswerers(ask({ mentions: [], mention_humans: true }))).toEqual([]);
  });

  it("gives a sentence for the person's own agent, not a shell command", () => {
    expect(replyPrompt(3)).toBe("Reply to #3 on the hailboard board: ");
    expect(replyPrompt(3)).not.toContain("…");
  });

  it("counts a reply from an agent as an answer", () => {
    const request = ask({ seq: 3, kind: "human_request" });
    const fromAgent = ask({ seq: 4, from: "alice/claude", reply_to: 3 });
    expect(openHumanRequests([request])).toHaveLength(1);
    expect(openHumanRequests([request, fromAgent])).toEqual([]);
  });
});

describe("receipts", () => {
  it("combines what the server said with the members' read cursors", () => {
    const message = msg(5, { recipients: ["bob", "bob/codex", "carol"], seen_by: ["carol"] });
    const members = [
      member("bob", { read_up_to: 2 }),
      member("bob/codex", { read_up_to: 5 }),
      member("carol", { read_up_to: 0 }),
    ];
    expect(receipts(message, members)).toEqual({ seen: ["bob/codex", "carol"], waiting: ["bob"] });
    expect(receipts(msg(6), members)).toEqual({ seen: [], waiting: [] });
  });
});

describe("orderDocuments", () => {
  const doc = (name: string, pinned = false): DocumentInfo => ({
    name,
    pinned,
    version: 1,
    updated_by: "alice",
    updated_at: "2026-11-13T10:00:00Z",
    size: 10,
  });
  it("puts the pinned document first, then the rest by name", () => {
    const order = orderDocuments([doc("b.md"), doc("plan.md", true), doc("a.md")]);
    expect(order.map((d) => d.name)).toEqual(["plan.md", "a.md", "b.md"]);
  });
});

describe("asksMembers", () => {
  const to = { recipients: ["bob/codex"] };
  it("is a message that asks somebody else something", () => {
    expect(asksMembers(msg(1, { ...to, body: "@bob/codex which port?" }))).toBe(true);
    expect(asksMembers(msg(1, { ...to, body: "@bob/codex (the order id?) tell me" }))).toBe(true);
    expect(asksMembers(msg(1, { ...to, body: "@bob/codex порт какой？" }))).toBe(true);
  });

  it("is not news, a note to nobody, a question for a person or a board event", () => {
    expect(asksMembers(msg(1, { ...to, body: "@bob/codex it is ready." }))).toBe(false);
    expect(asksMembers(msg(1, { body: "which port?" }))).toBe(false);
    expect(asksMembers(msg(1, { ...to, body: "ok?", mention_humans: true }))).toBe(false);
    expect(asksMembers(msg(1, { ...to, body: "ok?", kind: "activity" }))).toBe(false);
    expect(asksMembers(msg(1, { recipients: ["alice/claude"], body: "note to self?" }))).toBe(
      false,
    );
  });

  it("does not read question marks inside code, links and paths", () => {
    expect(asksMembers(msg(1, { ...to, body: "use `a ? b : c` there" }))).toBe(false);
    expect(asksMembers(msg(1, { ...to, body: "see https://x.test/a?b=1 for it" }))).toBe(false);
    expect(asksMembers(msg(1, { ...to, body: "call GET /orders?cursor=abc" }))).toBe(false);
  });
});
