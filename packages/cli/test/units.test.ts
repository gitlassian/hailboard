import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiClient, normalizeServer } from "../src/client.ts";
import { parseJoin, suggestOwner } from "../src/commands/init.ts";
import { findRepoConfig, REPO_CONFIG_NAME } from "../src/config.ts";
import { describeDelivery, formatMembers, formatMessage, formatReceipts } from "../src/format.ts";
import { writeFileIn } from "./helpers.ts";

const message = (overrides = {}) => ({
  seq: 12,
  from: "alice/claude",
  kind: "message" as const,
  body: "line one\nline two",
  mentions: ["bob/codex"],
  recipients: ["bob/codex"],
  seen_by: [] as string[],
  mention_all: false,
  mention_humans: false,
  reply_to: null,
  created_at: "2026-11-05T14:02:11Z",
  ...overrides,
});

describe("parseJoin", () => {
  it("reads the server and token from an invite link", () => {
    expect(parseJoin("https://board.example.com/join/inv_abc")).toEqual({
      server: "https://board.example.com",
      token: "inv_abc",
    });
  });

  it("keeps a path prefix and ignores a trailing slash", () => {
    expect(parseJoin("https://example.com/hailboard/join/inv_abc/")).toEqual({
      server: "https://example.com/hailboard",
      token: "inv_abc",
    });
  });

  it("accepts a bare token", () => {
    expect(parseJoin("inv_abc")).toEqual({ server: undefined, token: "inv_abc" });
  });

  it("rejects links that are not invite links", () => {
    expect(() => parseJoin("https://example.com/feed/rd_abc")).toThrow(/not an invite link/);
  });
});

describe("normalizeServer", () => {
  it("adds https:// to a bare host and drops trailing slashes", () => {
    expect(normalizeServer("ab.froti.dev")).toBe("https://ab.froti.dev");
    expect(normalizeServer("  ab.froti.dev/  ")).toBe("https://ab.froti.dev");
    expect(normalizeServer("example.com:8443/hailboard/")).toBe(
      "https://example.com:8443/hailboard",
    );
  });

  it("uses http:// for a bare local address", () => {
    expect(normalizeServer("localhost:8000")).toBe("http://localhost:8000");
    expect(normalizeServer("127.0.0.1:8000")).toBe("http://127.0.0.1:8000");
    expect(normalizeServer("[::1]:8000")).toBe("http://[::1]:8000");
  });

  it("keeps an address that already has a scheme", () => {
    expect(normalizeServer("http://10.0.0.5:8000/")).toBe("http://10.0.0.5:8000");
    expect(normalizeServer("HTTPS://AB.froti.dev")).toBe("https://ab.froti.dev");
  });

  it("rejects what is not a server address, with a hint", () => {
    for (const bad of ["", "not a url", "ftp://example.com", "https://", "https://ex ample.com"]) {
      expect(() => normalizeServer(bad)).toThrow(/is not a server address|No server address/);
    }
    try {
      normalizeServer("ftp://example.com");
    } catch (error) {
      expect((error as { hint?: string }).hint).toContain("https://");
    }
  });
});

describe("tasks on a server older than the client", () => {
  const answering = (status: number, message: string) =>
    (async () =>
      new Response(JSON.stringify({ error: { code: "not_found", message } }), {
        status,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

  it("says the server has no tasks instead of naming an endpoint", async () => {
    const client = new ApiClient("http://old.test", "key", answering(404, "no such endpoint"));
    await expect(client.tasks()).rejects.toThrow("has no tasks yet");
    await expect(client.addTask({ title: "x", take: false })).rejects.toThrow("has no tasks yet");
    await expect(client.taskAction(1, "take")).rejects.toThrow("has no tasks yet");
  });

  it("leaves a missing task as it is", async () => {
    const client = new ApiClient("http://new.test", "key", answering(404, "no task #9"));
    await expect(client.taskAction(9, "done")).rejects.toThrow("no task #9");
  });
});

describe("suggestOwner", () => {
  it("turns names into handles", () => {
    expect(suggestOwner("Jane Doe")).toBe("jane-doe");
    expect(suggestOwner("  Ünïcode__Name ")).toBe("n-code-name");
    expect(suggestOwner("")).toBeUndefined();
    expect(suggestOwner(undefined)).toBeUndefined();
    expect(suggestOwner("a".repeat(40))).toHaveLength(32);
  });
});

describe("formatMessage", () => {
  it("shows number, time, author, recipients and an indented body", () => {
    const text = formatMessage(message());
    expect(text).toMatch(
      /^#12 \d\d:\d\d {2}alice\/claude → @bob\/codex\n {4}line one\n {4}line two$/,
    );
  });

  it("shows broadcasts, replies and requests for a human", () => {
    const text = formatMessage(
      message({
        mentions: [],
        mention_all: true,
        mention_humans: true,
        reply_to: 7,
        kind: "human_request",
      }),
    );
    expect(text.split("\n")[0]).toMatch(/→ @all, @human {2}↩ #7 {2}\[needs a human\]$/);
  });

  it("shows who a message has reached when asked to", () => {
    const msg = message({ recipients: ["bob", "bob/codex"], seen_by: ["bob/codex"] });
    expect(formatMessage(msg)).not.toContain("seen by");
    expect(formatMessage(msg, { receipts: true }).split("\n").at(-1)).toBe(
      "    (seen by bob/codex; not yet by bob)",
    );
    expect(formatReceipts(message({ seen_by: [] }))).toBe("not seen yet by bob/codex");
    expect(formatReceipts(message({ seen_by: ["bob/codex"] }))).toBe("seen by bob/codex");
    expect(formatReceipts(message({ recipients: [], seen_by: [] }))).toBe("");
  });

  it("puts a board event on one line", () => {
    const text = formatMessage(
      message({ kind: "activity", mentions: [], body: "bob joined with the agent bob/codex." }),
    );
    expect(text).toMatch(/^#12 \d\d:\d\d {2}· bob joined with the agent bob\/codex\.$/);
  });

  it("omits the arrow when nobody is addressed", () => {
    expect(formatMessage(message({ mentions: [] })).split("\n")[0]).not.toContain("→");
  });
});

describe("describeDelivery", () => {
  const posted = (message: Record<string, unknown>) => ({
    message: {
      seq: 7,
      mentions: [],
      mention_all: false,
      mention_humans: false,
      reply_to: null,
      ...message,
    },
  });

  it("names who the message went to", () => {
    expect(describeDelivery(posted({ mentions: ["bob/codex", "carol"] }))).toBe(
      "Posted #7 to @bob/codex, @carol.",
    );
    expect(describeDelivery(posted({ mention_all: true, mentions: ["bob"] }))).toBe(
      "Posted #7 to everyone on the board.",
    );
    expect(describeDelivery(posted({ mention_humans: true }))).toBe(
      "Posted #7 to the people on the board.",
    );
    expect(describeDelivery(posted({ reply_to: 3, mentions: ["bob"] }))).toBe(
      "Posted #7 to @bob and the author of #3.",
    );
  });

  it("says when a message is in nobody's inbox", () => {
    const text = describeDelivery(posted({}));
    expect(text).toContain("Posted #7.");
    expect(text).toContain("no one's inbox");
    expect(text).toContain("@all");
  });
});

describe("formatMembers", () => {
  it("marks who is online and shows join times and statuses", () => {
    const now = new Date(2026, 10, 10, 18, 0);
    const text = formatMembers(
      [
        {
          handle: "alice",
          kind: "human",
          status_text: null,
          last_seen_at: null,
          last_active_at: null,
          read_up_to: 0,
          joined_at: new Date(2026, 10, 9, 9, 5).toISOString(),
          online: false,
        },
        {
          handle: "alice/claude",
          kind: "agent",
          status_text: "wiring /users",
          last_seen_at: null,
          last_active_at: null,
          read_up_to: 0,
          joined_at: new Date(2026, 10, 10, 14, 2).toISOString(),
          online: true,
        },
      ],
      now,
    );
    expect(text).toBe(
      "○ alice         human  joined 2026-11-09 09:05\n" +
        "● alice/claude  agent  joined today 14:02       wiring /users",
    );
  });
});

describe("findRepoConfig", () => {
  it("finds the file in a parent directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "hailboard-find-"));
    const config = { server: "http://x", board_id: "brd_1", board_name: "t" };
    await writeFileIn(root, REPO_CONFIG_NAME, JSON.stringify(config));
    const deep = join(root, "a", "b");
    await mkdir(deep, { recursive: true });

    const found = await findRepoConfig(deep);
    expect(found?.config).toEqual(config);
    expect(found?.dir).toBe(root);
  });

  it("returns null when there is none", async () => {
    const root = await mkdtemp(join(tmpdir(), "hailboard-none-"));
    expect(await findRepoConfig(root)).toBeNull();
  });

  it("explains a damaged file", async () => {
    const root = await mkdtemp(join(tmpdir(), "hailboard-bad-"));
    await writeFileIn(root, REPO_CONFIG_NAME, "{not json");
    await expect(findRepoConfig(root)).rejects.toThrow(/not valid JSON/);
  });
});

describe("what agents are told to run", () => {
  // Without --as agent a command acts as the person: a task taken or a part claimed that way is
  // recorded under "alice", and the board shows the agent "alice/claude" on no task.
  const ACTING =
    /hailboard (post|status|claim|release|doc (write|pin)|task (add|take|leave|done)|wait|inbox)\b[^`|]*/g;

  it("always acts as the agent, in the skill and in the session text", async () => {
    const { skillText } = await import("../src/adapters/claude-code/skill.ts");
    const { TALK } = await import("../src/hooks/harness.ts");
    const said = [
      skillText("claude"),
      TALK.cli.howTo,
      TALK.cli.answer,
      TALK.cli.more,
      TALK.cli.pinDoc,
      TALK.cli.updateDoc,
      TALK.cli.claim,
      TALK.cli.task,
    ].join("\n");
    const commands = said.match(ACTING) ?? [];
    expect(commands.length).toBeGreaterThan(12);
    expect(commands.filter((command) => !command.includes("--as agent"))).toEqual([]);
  });
});

describe("listings and usage errors", () => {
  it("lines up the paths of the parts", async () => {
    const { formatZones } = await import("../src/format.ts");
    const zone = (name: string, owner: string, paths: string[]) => ({
      id: name,
      name,
      owner,
      paths,
      note: null,
      stale: false,
      claimed_at: "2026-11-16T10:00:00Z",
      updated_at: "2026-11-16T10:00:00Z",
    });
    const lines = formatZones([
      zone("api", "bob/claude", ["packages/api"]),
      zone("routes", "alice/claude", ["packages/api/routes", "web"]),
    ]).split("\n");
    const day = (line: string) => line.search(/\S+ \d\d:\d\d$/);
    expect(day(lines[0] ?? "")).toBeGreaterThan(0);
    expect(day(lines[0] ?? "")).toBe(day(lines[1] ?? ""));
  });

  it("names an option the way it is typed and keeps Node's advice out", async () => {
    const alice = await (await import("./helpers.ts")).person("alice");
    const unknown = await alice.cli(["log", "--limit", "3"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("Unknown option '--limit'.\nUsage: hailboard log");
    expect(unknown.err).not.toContain("positional argument");

    const range = await alice.cli(["log", "-n", "0"]);
    expect(range.err).toContain("-n must be a whole number from 1 to 100");
    expect(range.err).not.toContain("--n ");
  });
});
