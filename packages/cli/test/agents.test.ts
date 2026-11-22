import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chooseAgent } from "../src/agents.ts";
import { team } from "./helpers.ts";

const json = (text: string) => JSON.parse(text);

describe("chooseAgent", () => {
  const agents = { claude: { tool: "claude" }, reviewer: {}, codex: { tool: "codex" } };

  it("takes the name asked for, or registers it", () => {
    expect(chooseAgent(agents, { name: "reviewer", tool: "claude" })).toEqual({
      kind: "found",
      name: "reviewer",
    });
    expect(chooseAgent(agents, { name: "new", tool: "codex" })).toEqual({
      kind: "register",
      name: "new",
      tool: "codex",
    });
  });

  it("matches the tool running the command, or registers an agent for it", () => {
    expect(chooseAgent(agents, { tool: "codex" })).toEqual({ kind: "found", name: "codex" });
    expect(chooseAgent(agents, { tool: "agy" })).toEqual({
      kind: "register",
      name: "agy",
      tool: "agy",
    });
    // An agent named after the tool counts even when its tool was not recorded.
    expect(chooseAgent({ codex: {} }, { tool: "codex" })).toEqual({ kind: "found", name: "codex" });
  });

  it("falls back to the only agent, and asks when there are several", () => {
    expect(chooseAgent({ cc: {} }, {})).toEqual({ kind: "found", name: "cc" });
    expect(chooseAgent({}, {})).toEqual({ kind: "none" });
    expect(chooseAgent(agents, {})).toEqual({
      kind: "ambiguous",
      names: ["claude", "codex", "reviewer"],
    });
  });
});

describe("several agents per person", () => {
  it("adds a second agent in a connected repository and keeps their messages apart", async () => {
    const { alice, bob } = await team();
    const added = await alice.cli(["init", "--agent", "codex", "--json"]);
    expect(added.code).toBe(0);
    expect(json(added.out)).toMatchObject({
      human: "alice",
      agent: "alice/codex",
      agents: ["alice/claude", "alice/codex"],
      already_member: true,
      agent_added: true,
    });

    // Running it again changes nothing.
    const again = json((await alice.cli(["init", "--agent", "codex", "--json"])).out);
    expect(again).toMatchObject({ agent: "alice/codex", agent_added: false });

    await bob.cli(["post", "--as", "agent", "@alice/codex only for codex"]);
    const codex = await alice.cli(["inbox", "--agent", "codex", "--json"]);
    expect(json(codex.out).messages.map((m: { body: string }) => m.body)).toEqual([
      "@alice/codex only for codex",
    ]);
    const claude = await alice.cli(["inbox", "--as", "agent", "--json"], {
      env: { CLAUDECODE: "1" },
    });
    expect(json(claude.out).messages).toEqual([]);

    // Nothing says which one: ask instead of guessing.
    const unclear = await alice.cli(["inbox", "--as", "agent"]);
    expect(unclear.code).toBe(1);
    expect(unclear.err).toContain("several agents here: claude, codex");
    expect(unclear.err).toContain("--agent <name>");

    const members = await bob.cli(["members", "--json"]);
    expect(members.out).toContain("alice/codex");
  });

  it("registers the agent of a new coding tool by itself", async () => {
    const { alice } = await team();
    const res = await alice.cli(["post", "--as", "agent", "--json", "hello from codex"], {
      env: { AI_AGENT: "codex_cli" },
    });
    expect(res.code).toBe(0);
    expect(json(res.out).message.from).toBe("alice/codex");
    expect(res.err).toContain('Added your agent alice/codex to board "team"');

    const creds = await alice.credentials();
    const [board] = Object.values(creds.boards) as Array<{ agents: Record<string, unknown> }>;
    expect(Object.keys(board?.agents ?? {}).sort()).toEqual(["claude", "codex"]);

    // The next command reuses it.
    const next = await alice.cli(["post", "--as", "agent", "again"], {
      env: { AI_AGENT: "codex_cli" },
    });
    expect(next.err).toBe("");
  });

  it("joins from a second repository as the same person, not as alice-2", async () => {
    const { alice, inviteUrl } = await team();
    const other = join(alice.cwd, "..", "other-repo");
    await mkdir(other, { recursive: true });
    const res = await alice.cli(["init", "--join", inviteUrl, "--json"], {
      cwd: other,
      env: { AI_AGENT: "codex_cli" },
    });
    expect(res.code).toBe(0);
    expect(json(res.out)).toMatchObject({
      human: "alice",
      agent: "alice/codex",
      already_member: true,
      agent_added: true,
      renamed: false,
    });
  });

  it("acts as the person's Claude Code agent in Claude Code hooks", async () => {
    const { alice, bob } = await team(); // bob has only bob/codex
    await alice.cli(["post", "--as", "agent", "@bob/claude are you there?"]);
    const res = await bob.cli(["hook", "prompt"], {
      stdin: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: bob.cwd }),
    });
    expect(res.code).toBe(0);
    // The hook registered bob/claude for Bob instead of acting as bob/codex.
    const members = await alice.cli(["members", "--json"]);
    expect(members.out).toContain("bob/claude");
  });

  it("reads credentials files written before several agents", async () => {
    const { alice } = await team();
    const creds = await alice.credentials();
    const [id, board] = Object.entries(creds.boards)[0] as [
      string,
      { agents: Record<string, { handle: string; api_key: string }> } & Record<string, unknown>,
    ];
    const { agents, ...rest } = board;
    const legacy = { boards: { [id]: { ...rest, agent: agents.claude } } };
    await writeFile(join(alice.configDir, "credentials.json"), JSON.stringify(legacy));

    const res = await alice.cli(["post", "--as", "agent", "--json", "still works"]);
    expect(res.code).toBe(0);
    expect(json(res.out).message.from).toBe("alice/claude");

    // The next save writes the new shape and keeps the old agent.
    await alice.cli(["init", "--agent", "codex"]);
    const saved = await alice.credentials();
    const savedBoard = saved.boards[id] as Record<string, unknown>;
    expect(savedBoard.agent).toBeUndefined();
    expect(Object.keys(savedBoard.agents as object).sort()).toEqual(["claude", "codex"]);
  });
});
