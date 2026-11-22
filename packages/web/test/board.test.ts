import { describe, expect, it } from "vitest";
import { agentTiles, daySummary, recentThreads, taskGroups, weightOf } from "../src/board.ts";
import type { MemberOut, Message, Task } from "../src/protocol.ts";

const NOW = Date.parse("2026-11-13T15:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function member(handle: string, extra: Partial<MemberOut> = {}): MemberOut {
  return {
    handle,
    kind: handle.includes("/") ? "agent" : "human",
    status_text: null,
    last_seen_at: ago(0),
    last_active_at: ago(0),
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
    created_at: ago(10),
    ...extra,
  };
}

describe("recentThreads", () => {
  it("pairs a question with its reply or the addressee's next message, newest first", () => {
    const threads = recentThreads([
      msg(1, "bob/claude", { recipients: ["alice/codex"], created_at: ago(30) }),
      msg(2, "alice/codex", { reply_to: 1, created_at: ago(27) }),
      msg(3, "chris/hermes", { recipients: ["alice/codex"], created_at: ago(20) }),
      msg(4, "alice/codex", { created_at: ago(18) }),
      msg(5, "bob/claude", { recipients: ["alice/codex"], created_at: ago(5) }),
    ]);
    expect(threads.map((t) => [t.question.seq, t.answer?.seq ?? null])).toEqual([
      [5, null],
      [3, 4],
      [1, 2],
    ]);
  });

  it("skips news, questions for a person, board events and notes to nobody", () => {
    const threads = recentThreads([
      msg(1, "bob/claude"),
      msg(2, "bob/claude", { kind: "human_request" }),
      msg(3, "bob/claude", { kind: "activity", recipients: ["x/y"] }),
      msg(4, "bob/claude", { recipients: ["alice/codex"], body: "@alice/codex it is ready." }),
    ]);
    expect(threads).toEqual([]);
  });

  it("counts a follow-up question in a reply as a question of its own", () => {
    const threads = recentThreads([
      msg(1, "bob/claude", { recipients: ["alice/codex"] }),
      msg(2, "alice/codex", { reply_to: 1, recipients: ["bob/claude"], body: "which one?" }),
    ]);
    expect(threads.map((t) => [t.question.seq, t.answer?.seq ?? null])).toEqual([
      [2, null],
      [1, 2],
    ]);
  });
});

describe("agentTiles", () => {
  it("orders working, waiting, then offline agents and finds whom each talks with", () => {
    const members = [
      member("alice"),
      member("zed/codex", { online: false }),
      member("bob/claude"),
      member("alice/codex"),
    ];
    const messages = [
      msg(1, "bob/claude", { recipients: ["alice/codex"], created_at: ago(30) }),
      msg(2, "alice/codex", { recipients: ["bob/claude"], created_at: ago(29) }),
      msg(3, "alice/codex", { recipients: ["zed/codex"], created_at: ago(28) }),
    ];
    const tiles = agentTiles(members, messages, NOW);
    // alice/codex waits: her last question to zed/codex has no answer.
    expect(tiles.map((t) => t.member.handle)).toEqual(["bob/claude", "alice/codex", "zed/codex"]);
    expect(tiles[1]?.state.activity).toBe("waiting");
    const alice = tiles[1];
    expect(alice?.last?.seq).toBe(3);
    expect(alice?.today).toBe(2);
    expect(alice?.partners).toEqual(["bob/claude", "zed/codex"]);
  });
});

describe("daySummary", () => {
  it("counts the last 24 hours and the median answer time", () => {
    const summary = daySummary(
      [
        msg(1, "old", { created_at: ago(2000), recipients: ["x"] }),
        msg(2, "bob/claude", { recipients: ["alice/codex"], created_at: ago(30) }),
        msg(3, "alice/codex", { reply_to: 2, created_at: ago(26) }),
        msg(4, "bob/claude", { recipients: ["alice/codex"], created_at: ago(10) }),
        msg(5, "alice", {
          kind: "activity",
          body: "alice updated the document plan.md (version 2).",
        }),
      ],
      NOW,
    );
    expect(summary).toEqual({
      messages: 3,
      questions: 2,
      answered: 1,
      medianAnswerMinutes: 4,
      documents: 1,
    });
  });
});

function task(number: number, agents: string[], extra: Partial<Task> = {}): Task {
  return {
    number,
    title: `t${number}`,
    part: null,
    state: "doing",
    agents,
    created_by: "alice",
    created_at: ago(60),
    updated_at: ago(30),
    done_at: null,
    ...extra,
  };
}

describe("taskGroups", () => {
  const members = [
    member("alice"),
    member("alice/claude"),
    member("alice/codex"),
    member("bob/claude"),
  ];
  const tiles = agentTiles(members, [], NOW);

  it("makes a piece per task in progress, weighed by the agents on it", () => {
    const groups = taskGroups(tiles, [
      task(1, ["bob/claude"]),
      task(2, ["alice/claude", "alice/codex"]),
      task(3, [], { state: "todo" }),
      task(4, ["bob/claude"], { state: "done" }),
    ]);
    expect(groups.map((g) => [g.key, weightOf(g)])).toEqual([
      ["task:2", 2],
      ["task:1", 1],
    ]);
  });

  it("gives an agent on no task a piece of its own", () => {
    const groups = taskGroups(tiles, [task(1, ["alice/claude", "alice/codex"])]);
    expect(groups.map((g) => g.key)).toEqual(["task:1", "agent:bob/claude"]);
    expect(groups[1]?.task).toBeNull();
  });

  it("keeps people on a task apart from the agents", () => {
    const groups = taskGroups(tiles, [task(1, ["alice", "bob/claude"])]);
    const piece = groups.find((g) => g.key === "task:1");
    expect(piece?.people).toEqual(["alice"]);
    expect(piece?.tiles.map((t) => t.member.handle)).toEqual(["bob/claude"]);
  });

  it("falls back to status lines without tasks", () => {
    const withStatus = agentTiles(
      [member("a/claude", { status_text: "Cart" }), member("b/codex", { status_text: "cart" })],
      [],
      NOW,
    );
    const groups = taskGroups(withStatus, null);
    expect(groups).toHaveLength(1);
    expect(weightOf(groups[0] as (typeof groups)[number])).toBe(2);
  });
});
