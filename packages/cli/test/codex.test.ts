import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { skillText } from "../src/adapters/claude-code/skill.ts";
import { mcpBlock, mcpState, withMcp, withoutMcp } from "../src/adapters/codex/config.ts";
import { person, team } from "./helpers.ts";

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const USER_CONFIG = `# my settings
model = "gpt-6"

[mcp_servers.docs]
url = "https://example.com/mcp"

# the last table
[desktop]
accent = "#0169cc"
`;

describe("Codex config.toml", () => {
  it("adds our MCP server at the end and changes nothing else", () => {
    const next = withMcp(USER_CONFIG, "hailboard");
    expect(next.startsWith(USER_CONFIG)).toBe(true);
    expect(next).toContain('[mcp_servers.hailboard]\ncommand = "hailboard"');
    expect(next).toContain('args = ["mcp", "--agent", "codex"]');
    expect(next).toContain("tool_timeout_sec = 120");
    expect(mcpState(next, "hailboard")).toBe("current");
    expect(withMcp(next, "hailboard")).toBe(next);
  });

  it("creates the file content when there is none", () => {
    expect(withMcp(null, "hailboard")).toBe(`${mcpBlock("hailboard")}\n`);
    expect(mcpState(null, "hailboard")).toBe("missing");
  });

  it("removes exactly what it added", () => {
    const added = withMcp(USER_CONFIG, "hailboard");
    expect(withoutMcp(added)).toEqual({ text: USER_CONFIG, removed: true });
    expect(withoutMcp(USER_CONFIG)).toEqual({ text: USER_CONFIG, removed: false });
  });

  it("updates its own table in place, keeping the tables and comments after it", () => {
    const old = `${mcpBlock("hailboard").replace("120", "60")}\n[mcp_servers.hailboard.env]\nX = "1"\n\n# the next table\n[desktop]\naccent = "x"\n`;
    expect(mcpState(old, "hailboard")).toBe("outdated");
    const next = withMcp(old, "/opt/bin/hailboard");
    expect(next).toBe(
      `${mcpBlock("/opt/bin/hailboard")}\n\n# the next table\n[desktop]\naccent = "x"\n`,
    );
    expect(next).toContain('command = "/opt/bin/hailboard"');
  });

  it("passes the arguments of a --command along", () => {
    expect(mcpBlock("node /tmp/cli.js")).toContain(
      'command = "node"\nargs = ["/tmp/cli.js", "mcp", "--agent", "codex"]',
    );
  });

  it("leaves an hailboard server it did not add alone", () => {
    const handMade = `[mcp_servers.hailboard]\ncommand = "hailboard"\nargs = ["mcp"]\n`;
    expect(mcpState(handMade, "hailboard")).toBe("foreign");
    expect(withMcp(handMade, "hailboard")).toBe(handMade);
    expect(withoutMcp(handMade).removed).toBe(false);

    const dotted = `mcp_servers.hailboard.command = "hailboard"\n`;
    expect(mcpState(dotted, "hailboard")).toBe("foreign");
    const inline = `[mcp_servers]\nhailboard = { command = "hailboard" }\n`;
    expect(mcpState(inline, "hailboard")).toBe("foreign");
  });

  it("still knows its table after Codex rewrote the file", () => {
    // What `codex mcp add` leaves behind: comments gone, numbers written as floats.
    const rewritten = `# mine\nmodel = "x"\n\n[mcp_servers.hailboard]\ncommand = "hailboard"\nargs = ["mcp", "--agent", "codex"]\ntool_timeout_sec = 120.0\n\n[mcp_servers.zz]\ncommand = "echo"\nargs = ["hi"]\n`;
    expect(mcpState(rewritten, "hailboard")).toBe("current");
    expect(withMcp(rewritten, "hailboard")).toBe(rewritten);
    expect(withoutMcp(rewritten)).toEqual({
      text: `# mine\nmodel = "x"\n\n[mcp_servers.zz]\ncommand = "echo"\nargs = ["hi"]\n`,
      removed: true,
    });
    expect(mcpState(rewritten, "/opt/bin/hailboard")).toBe("outdated");
  });
});

/** A person whose machine has Codex (its folder exists). */
async function codexUser(name = "cody") {
  const p = await person(name);
  await mkdir(join(p.home, ".codex"), { recursive: true });
  return p;
}

const codexConfig = (home: string) => join(home, ".codex", "config.toml");
const codexHooks = (home: string) => join(home, ".codex", "hooks.json");
const codexSkill = (home: string) => join(home, ".agents", "skills", "hailboard", "SKILL.md");

type Hooks = Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;

describe("hailboard setup with Codex", () => {
  it("adds the MCP server, the hooks and the skill", async () => {
    const p = await codexUser();
    await writeFile(codexConfig(p.home), USER_CONFIG);
    const res = await p.cli(["setup"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Codex\n  MCP server: added in");
    expect(res.out).toContain("/hooks");
    expect(res.out).toContain("into Claude Code or Codex");

    const config = await readFile(codexConfig(p.home), "utf8");
    expect(config.startsWith(USER_CONFIG)).toBe(true);
    expect(config).toContain("[mcp_servers.hailboard]");

    const hooks = JSON.parse(await readFile(codexHooks(p.home), "utf8")).hooks as Hooks;
    expect(Object.keys(hooks).sort()).toEqual(
      ["PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"].sort(),
    );
    const stop = hooks.Stop?.[0]?.hooks ?? [];
    expect(stop.map((h) => h.command)).toEqual([
      "hailboard hook stop --tool codex # hailboard-managed",
      "hailboard hook wake --tool codex # hailboard-managed",
    ]);
    expect(stop[1]).toMatchObject({ async: true, timeout: 3600 });
    expect(stop[1]?.asyncRewake).toBeUndefined();

    const skill = await readFile(codexSkill(p.home), "utf8");
    expect(skill).toBe(skillText("codex"));
    expect(skill).toContain("hailboard MCP server");
    expect(skill).toContain("outside the sandbox");
  });

  it("changes nothing when run again, and reports its state", async () => {
    const p = await codexUser();
    await p.cli(["setup"]);
    const config = await readFile(codexConfig(p.home), "utf8");
    const res = await p.cli(["setup"]);
    expect(res.out).toContain("MCP server: already there");
    expect(await readFile(codexConfig(p.home), "utf8")).toBe(config);

    const status = JSON.parse((await p.cli(["setup", "--status", "--json"])).out);
    expect(status.codex).toMatchObject({
      present: true,
      mcp: "current",
      wake: true,
      skill: "current",
    });
    expect(status.codex.hooks).toHaveLength(4);
  });

  it("creates a config file readable only by the person", async () => {
    const p = await codexUser();
    await p.cli(["setup"]);
    expect((await stat(codexConfig(p.home))).mode & 0o777).toBe(0o600);
  });

  it("removes everything it added", async () => {
    const p = await codexUser();
    await writeFile(codexConfig(p.home), USER_CONFIG);
    await p.cli(["setup"]);
    const res = await p.cli(["setup", "--remove"]);
    expect(res.out).toContain("Removed the hailboard MCP server");
    expect(res.out).toContain("Removed 5 hailboard hooks from");
    expect(await readFile(codexConfig(p.home), "utf8")).toBe(USER_CONFIG);
    expect(await exists(codexHooks(p.home))).toBe(false); // it did not exist before
    expect(await exists(codexSkill(p.home))).toBe(false);
  });

  it("leaves Codex alone with --no-codex, and when it is not installed", async () => {
    const p = await codexUser();
    const res = await p.cli(["setup", "--no-codex"]);
    expect(res.out).not.toContain("Codex\n");
    expect(await exists(codexConfig(p.home))).toBe(false);

    const without = await person("nocodex");
    const plain = await without.cli(["setup"]);
    expect(plain.out).not.toContain("MCP server");
    expect(await exists(codexConfig(without.home))).toBe(false);
    expect((await without.cli(["setup", "--status"])).out).toContain("Codex: not found");
  });
});

const input = (cwd: string, event: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ hook_event_name: event, session_id: "thr_1", cwd, ...extra });

describe("Codex hooks", () => {
  it("act as the person's Codex agent and point to the MCP tools", async () => {
    const { alice, bob } = await team({ bobAgent: "codex" });
    await alice.cli(["post", "--as", "agent", "@bob/codex the endpoint is ready"]);

    const res = await bob.cli(["hook", "session-start", "--tool", "codex"], {
      stdin: input(bob.cwd, "SessionStart", { source: "startup" }),
    });
    const context = JSON.parse(res.out).hookSpecificOutput.additionalContext as string;
    expect(context).toContain("as bob/codex");
    expect(context).toContain("tools of the hailboard MCP server");
    expect(context).not.toContain("--as agent");
    expect(context).toContain("the endpoint is ready");
  });

  it("register a Codex agent for a person who has only Claude Code so far", async () => {
    const { bob } = await team({ bobAgent: "claude" });
    const res = await bob.cli(["hook", "session-start", "--tool", "codex"], {
      stdin: input(bob.cwd, "SessionStart"),
    });
    expect(JSON.parse(res.out).hookSpecificOutput.additionalContext).toContain("as bob/codex");
    expect(Object.keys((await bob.credentials()).boards).length).toBe(1);
  });

  it("ask the agent to answer with the post tool before it stops", async () => {
    const { alice, bob } = await team({ bobAgent: "codex" });
    await alice.cli(["post", "--as", "agent", "@bob/codex which port?"]);
    const res = await bob.cli(["hook", "stop", "--tool", "codex"], {
      stdin: input(bob.cwd, "Stop", { stop_hook_active: false }),
    });
    const parsed = JSON.parse(res.out);
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("with the hailboard `post` tool");
  });

  it("reject an unknown tool", async () => {
    const { bob } = await team();
    const res = await bob.cli(["hook", "prompt", "--tool", "vim"]);
    expect(res.code).toBe(2);
    expect(res.err).toContain('Unknown tool "vim"');
  });
});

/** A stand-in for the `codex` command that records how it was called. */
async function fakeCodex(exitCode: number) {
  const dir = await mkdtemp(join(tmpdir(), "hailboard-fake-codex-"));
  const log = join(dir, "calls.json");
  const script = join(dir, "codex");
  await writeFile(
    script,
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(${exitCode});\n`,
  );
  await chmod(script, 0o755);
  return { script, calls: async () => JSON.parse(await readFile(log, "utf8")) as string[] };
}

describe("Codex wake hook", () => {
  const fast = { HAILBOARD_WAKE_POLL_SECONDS: "1", HAILBOARD_WAKE_SECONDS: "20" };
  const env = (codex: string) => ({ ...fast, HAILBOARD_CODEX_COMMAND: codex });

  it("queues new messages in the idle Codex session", async () => {
    const { alice, bob } = await team({ bobAgent: "codex" });
    const codex = await fakeCodex(0);
    const listening = bob.cli(["hook", "wake", "--tool", "codex"], {
      stdin: input(bob.cwd, "Stop", { session_id: "019a-thread", stop_hook_active: false }),
      env: { ...env(codex.script), PATH: process.env.PATH ?? "" },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await alice.cli(["post", "--as", "agent", "@bob/codex are you there?"]);

    const res = await listening;
    expect(res).toEqual({ code: 0, out: "", err: "" });
    const [command, flag, thread, messageFlag, message] = await codex.calls();
    expect([command, flag, thread, messageFlag]).toEqual([
      "queue",
      "--thread",
      "019a-thread",
      "--message",
    ]);
    expect(message).toContain("alice/claude → @bob/codex");
    expect(message).toContain("are you there?");
    expect(message).toContain("with the hailboard `post` tool");
  });

  it("prints the messages when Codex cannot take them, so they reach the next turn", async () => {
    const { alice, bob } = await team({ bobAgent: "codex" });
    const codex = await fakeCodex(1);
    const listening = bob.cli(["hook", "wake", "--tool", "codex"], {
      stdin: input(bob.cwd, "Stop", { stop_hook_active: false }),
      env: { ...env(codex.script), PATH: process.env.PATH ?? "" },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await alice.cli(["post", "--as", "agent", "@bob/codex hello"]);

    const res = await listening;
    expect(res.code).toBe(0);
    expect(res.out).toContain("hello");
    expect(res.out).toContain("while you were idle");
  });
});
