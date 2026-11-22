import { describe, expect, it } from "vitest";
import { candidates, modelName } from "../src/agent-sessions.ts";
import { type Person, team } from "./helpers.ts";

/** What Claude Code sets for the commands and hooks of one session. */
function claudeSession(session: string, pid: number) {
  return { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: session, CLAUDE_PID: String(pid) };
}

async function postAs(who: Person, env: Record<string, string>, text: string): Promise<string> {
  const res = await who.cli(["post", "--as", "agent", "--json", text], { env });
  expect(res.code, res.err).toBe(0);
  return JSON.parse(res.out).message.from as string;
}

async function startSession(who: Person, env: Record<string, string>, model?: string) {
  const input = {
    hook_event_name: "SessionStart",
    session_id: env.CLAUDE_CODE_SESSION_ID,
    cwd: who.cwd,
  };
  const res = await who.cli(["hook", "session-start"], {
    env,
    stdin: JSON.stringify(model ? { ...input, model } : input),
  });
  expect(res.code).toBe(0);
  return res.out;
}

describe("names for the sessions of one person", () => {
  it("shortens model names", () => {
    expect(modelName("claude-opus-5")).toBe("opus");
    expect(modelName("claude-sonnet-5-5[1m]")).toBe("sonnet");
    expect(modelName("gpt-5.5-codex")).toBe("gpt-5-5");
    expect(modelName(undefined)).toBeUndefined();
    expect(candidates("claude", "opus").slice(0, 3)).toEqual(["claude", "opus", "opus-2"]);
    expect(candidates("claude", undefined).slice(0, 2)).toEqual(["claude", "claude-2"]);
  });

  it("gives a second live session a name of its own, after its model", async () => {
    const { alice, bob } = await team();
    // Two live processes: this test runner and its parent.
    const first = claudeSession("s-first", process.pid);
    const second = claudeSession("s-second", process.ppid);

    expect(await postAs(alice, first, "one")).toBe("alice/claude");
    const intro = await startSession(alice, second, "claude-sonnet-5-5");
    expect(intro).toContain("alice/sonnet");
    expect(await postAs(alice, second, "two")).toBe("alice/sonnet");
    // The first session keeps its name.
    expect(await postAs(alice, first, "three")).toBe("alice/claude");

    // A message to one of them reaches only that session.
    expect((await bob.cli(["post", "--as", "agent", "@alice/claude ping"])).code).toBe(0);
    const firstInbox = await alice.cli(["inbox", "--as", "agent"], { env: first });
    expect(firstInbox.out).toContain("ping");
    const secondInbox = await alice.cli(["inbox", "--as", "agent"], { env: second });
    expect(secondInbox.out).not.toContain("ping");
  });

  it("numbers a session without a model, and hands names over when sessions end", async () => {
    const { alice } = await team();
    const first = claudeSession("s-a", process.pid);
    expect(await postAs(alice, first, "a")).toBe("alice/claude");
    expect(await postAs(alice, claudeSession("s-b", process.ppid), "b")).toBe("alice/claude-2");

    // After /clear the same process runs a new session: it takes the name of the old one.
    expect(await postAs(alice, claudeSession("s-a2", process.pid), "c")).toBe("alice/claude");

    // A session whose process is gone gives its name up.
    const gone = claudeSession("s-gone", 2 ** 22 + 12345);
    const { alice: another } = await team();
    expect(await postAs(another, gone, "d")).toBe("alice/claude");
    expect(await postAs(another, claudeSession("s-next", process.ppid), "e")).toBe("alice/claude");
  });

  it("keeps one agent when the person names it", async () => {
    const { alice } = await team();
    const first = claudeSession("s-1", process.pid);
    const second = claudeSession("s-2", process.ppid);
    expect(await postAs(alice, first, "x")).toBe("alice/claude");
    const named = await alice.cli(["post", "--agent", "claude", "--json", "y"], { env: second });
    expect(JSON.parse(named.out).message.from).toBe("alice/claude");
  });
});
