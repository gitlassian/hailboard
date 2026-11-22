import { describe, expect, it } from "vitest";
import {
  ACTIVE_MS,
  agentOf,
  agentState,
  assignLooks,
  lookOf,
  ownerOf,
  SHAPES,
  WAITING_MS,
} from "../src/people.ts";
import type { MemberOut, Message } from "../src/protocol.ts";

const NOW = Date.parse("2026-11-13T15:00:00Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function member(handle: string, extra: Partial<MemberOut> = {}): MemberOut {
  return {
    handle,
    kind: handle.includes("/") ? "agent" : "human",
    status_text: null,
    last_seen_at: null,
    last_active_at: null,
    joined_at: "2026-11-13T09:00:00Z",
    read_up_to: 0,
    online: true,
    ...extra,
  };
}

function msg(seq: number, from: string, extra: Partial<Message> = {}): Message {
  return {
    seq,
    from,
    kind: "message",
    // Worded as a question, so a message with recipients asks them something.
    body: `q${seq}?`,
    mentions: [],
    recipients: [],
    seen_by: [],
    mention_all: false,
    mention_humans: false,
    reply_to: null,
    created_at: at(60_000),
    ...extra,
  };
}

describe("handles", () => {
  it("splits a handle into person and agent", () => {
    expect(ownerOf("alice/claude")).toBe("alice");
    expect(ownerOf("alice")).toBe("alice");
    expect(agentOf("alice/claude")).toBe("claude");
    expect(agentOf("alice")).toBeNull();
  });
});

describe("assignLooks", () => {
  it("gives the first people distinct shapes and colours in the order they joined", () => {
    const looks = assignLooks([
      member("bob", { joined_at: "2026-11-13T10:00:00Z" }),
      member("alice", { joined_at: "2026-11-13T09:00:00Z" }),
      member("alice/claude"),
      member("chris", { joined_at: "2026-11-13T11:00:00Z" }),
    ]);
    expect([...looks.keys()]).toEqual(["alice", "bob", "chris"]);
    expect(looks.get("alice")).toEqual({ shape: SHAPES[0], colour: 0 });
    expect(looks.get("bob")).toEqual({ shape: SHAPES[1], colour: 1 });
    expect(looks.get("chris")).toEqual({ shape: SHAPES[2], colour: 2 });
  });

  it("keeps a person's look when someone joins later", () => {
    const before = assignLooks([
      member("alice"),
      member("bob", { joined_at: "2026-11-13T10:00:00Z" }),
    ]);
    const after = assignLooks([
      member("alice"),
      member("bob", { joined_at: "2026-11-13T10:00:00Z" }),
      member("dana", { joined_at: "2026-11-13T12:00:00Z" }),
    ]);
    expect(after.get("alice")).toEqual(before.get("alice"));
    expect(after.get("bob")).toEqual(before.get("bob"));
  });
});

describe("lookOf", () => {
  it("gives an agent the look of its person", () => {
    const looks = assignLooks([
      member("alice"),
      member("bob", { joined_at: "2026-11-13T10:00:00Z" }),
    ]);
    expect(lookOf("bob/codex", looks)).toEqual(looks.get("bob"));
  });

  it("gives someone unknown a stable look from the name", () => {
    const looks = new Map();
    expect(lookOf("zed/claude", looks)).toEqual(lookOf("zed", looks));
    expect(SHAPES).toContain(lookOf("zed", looks).shape);
  });
});

describe("agentState", () => {
  const agent = (extra: Partial<MemberOut> = {}) =>
    member("bob/claude", { last_seen_at: at(30_000), last_active_at: at(30_000), ...extra });

  it("is offline when the agent is not connected", () => {
    expect(agentState(agent({ online: false }), [], NOW).activity).toBe("offline");
  });

  it("is working after a recent step of work, idle when it only waits for messages", () => {
    expect(agentState(agent(), [], NOW).activity).toBe("working");
    const listening = agent({ last_active_at: at(ACTIVE_MS + 60_000) });
    expect(agentState(listening, [], NOW).activity).toBe("idle");
    expect(agentState(agent({ last_active_at: null }), [], NOW).activity).toBe("idle");
  });

  it("counts a connected agent as working on a server that does not report activity", () => {
    const old = agent();
    delete (old as Partial<MemberOut>).last_active_at;
    expect(agentState(old, [], NOW).activity).toBe("working");
  });

  it("waits while a question to another agent has no answer", () => {
    const asked = msg(5, "bob/claude", { recipients: ["alice/codex"], mentions: ["alice/codex"] });
    const state = agentState(agent(), [asked], NOW);
    expect(state.activity).toBe("waiting");
    expect(state.asked?.seq).toBe(5);
  });

  it("stops waiting once the addressee writes or replies", () => {
    const asked = msg(5, "bob/claude", { recipients: ["alice/codex"] });
    const answer = msg(6, "alice/codex", { reply_to: 5 });
    expect(agentState(agent(), [asked, answer], NOW).activity).toBe("working");
    const later = msg(6, "alice/codex");
    expect(agentState(agent(), [asked, later], NOW).activity).toBe("working");
  });

  it("does not wait on an old question", () => {
    const asked = msg(5, "bob/claude", {
      recipients: ["alice/codex"],
      created_at: at(WAITING_MS + 60_000),
    });
    expect(agentState(agent(), [asked], NOW).asked).toBeNull();
  });

  it("does not wait after news or an answer, only after a question", () => {
    const news = msg(5, "bob/claude", { recipients: ["alice/codex"], body: "@alice/codex done." });
    expect(agentState(agent(), [news], NOW).activity).toBe("working");
    const path = msg(5, "bob/claude", {
      recipients: ["alice/codex"],
      body: "@alice/codex use GET /orders?cursor= and `a ? b : c`",
    });
    expect(agentState(agent(), [path], NOW).asked).toBeNull();
  });

  it("keeps a question for a person open however old it is", () => {
    const ask = msg(3, "bob/claude", {
      kind: "human_request",
      created_at: at(26 * 60 * 60_000),
    });
    const later = msg(9, "bob/claude", { created_at: at(20 * 60 * 60_000) });
    const state = agentState(agent(), [ask, later], NOW);
    expect(state.needsPerson?.seq).toBe(3);
  });

  it("only looks at the agent's latest message", () => {
    const asked = msg(5, "bob/claude", { recipients: ["alice/codex"] });
    const note = msg(6, "bob/claude");
    expect(agentState(agent(), [asked, note], NOW).asked).toBeNull();
  });

  it("finds an unanswered question for a person", () => {
    const ask = msg(7, "bob/claude", { kind: "human_request" });
    const state = agentState(agent(), [ask], NOW);
    expect(state.needsPerson?.seq).toBe(7);
    expect(state.asked).toBeNull();
    const answered = agentState(agent(), [ask, msg(8, "bob", { reply_to: 7 })], NOW);
    expect(answered.needsPerson).toBeNull();
  });

  it("ignores board events", () => {
    const event = msg(5, "bob/claude", { kind: "activity", recipients: ["alice/codex"] });
    expect(agentState(agent(), [event], NOW).asked).toBeNull();
  });
});
