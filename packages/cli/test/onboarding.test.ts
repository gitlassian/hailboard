import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectAgent } from "../src/agents.ts";
import { person, serverUrl, team } from "./helpers.ts";

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const create = ["init", "--server", "", "--name", "team", "--json"];
const createArgs = () => create.map((a) => (a === "" ? serverUrl() : a));

describe("detectAgent", () => {
  it("recognises the agent from the variables it sets", () => {
    expect(detectAgent({ CLAUDECODE: "1" })).toBe("claude");
    expect(detectAgent({ AI_AGENT: "claude-code_2-1-316_agent" })).toBe("claude");
    expect(detectAgent({ AI_AGENT: "codex_cli" })).toBe("codex");
    expect(detectAgent({ CODEX_SANDBOX: "seatbelt" })).toBe("codex");
    expect(detectAgent({ CURSOR_AGENT: "1" })).toBe("cursor");
    expect(detectAgent({})).toBeUndefined();
  });
});

describe("init run by an agent", () => {
  it("picks the person's name from git and the agent from the environment", async () => {
    const p = await person("ignored");
    await writeFile(join(p.home, ".gitconfig"), "[user]\n\tname = Jane Doe\n");
    const res = await p.cli(createArgs(), {
      env: { PATH: process.env.PATH ?? "", AI_AGENT: "codex_cli", USER: "jd" },
    });
    expect(res.code).toBe(0);
    const out = JSON.parse(res.out);
    expect(out).toMatchObject({ human: "jane-doe", agent: "jane-doe/codex", renamed: false });
    // Run by Codex: no Claude Code hooks, and a pointer to the one-time Codex setup instead.
    expect(out.claude_code).toBe("codex-not-set-up");
  });

  it("falls back to the login name", async () => {
    const p = await person("sam");
    const out = JSON.parse((await p.cli(createArgs())).out);
    expect(out).toMatchObject({ human: "sam", agent: "sam/claude" });
  });

  it("gives a picked name a number when it is taken, but not a name given with --owner", async () => {
    const { inviteUrl } = await team();
    const other = await person("alice"); // a second "alice" on another machine
    const res = await other.cli(["init", "--join", inviteUrl, "--json"]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.out)).toMatchObject({ human: "alice-2", renamed: true });
    // The board's feed says where the number came from.
    const log = await other.cli(["log"]);
    expect(log.out).toContain(
      '· alice-2 joined with the agent alice-2/claude through an invite from alice (the name "alice" was taken).',
    );

    const text = await (await person("alice")).cli(["init", "--join", inviteUrl]);
    expect(text.out).toContain('"alice" was already taken on this board, so you are "alice-3"');

    const given = await (await person("x")).cli(["init", "--join", inviteUrl, "--owner", "alice"]);
    expect(given.code).toBe(1);
    expect(given.err).toContain("is taken on this board");
  });

  it("returns a message to forward and a feed link", async () => {
    const p = await person("sam");
    const out = JSON.parse((await p.cli(createArgs())).out);
    expect(out.invite_message).toBe(
      `Join our hailboard board "team": paste this into your coding agent: ${out.invite_url}`,
    );
    expect(out.feed_url).toMatch(/\/feed\/rd_/);

    const text = await (await person("tom")).cli([
      "init",
      "--server",
      serverUrl(),
      "--name",
      "web",
    ]);
    expect(text.out).toContain(
      "Send this to your teammates; they paste it into their coding agent:",
    );
    expect(text.out).toContain(
      'Join our hailboard board "web": paste this into your coding agent: ',
    );
  });

  it("adds the Claude Code hooks by itself inside Claude Code", async () => {
    const p = await person("sam");
    const res = await p.cli(createArgs(), { env: { CLAUDECODE: "1" } });
    expect(JSON.parse(res.out)).toMatchObject({ agent: "sam/claude", claude_code: "installed" });
    const settings = JSON.parse(
      await readFile(join(p.cwd, ".claude", "settings.local.json"), "utf8"),
    );
    expect(Object.keys(settings.hooks)).toContain("Stop");

    const q = await person("kim");
    const skipped = await q.cli([...createArgs(), "--no-claude-code"], {
      env: { CLAUDECODE: "1" },
    });
    expect(JSON.parse(skipped.out).claude_code).toBe("skipped");
    expect(await exists(join(q.cwd, ".claude", "settings.local.json"))).toBe(false);
  });

  it("installs the hooks with --json --claude-code too", async () => {
    const p = await person("sam");
    const res = await p.cli([...createArgs(), "--claude-code"]);
    expect(JSON.parse(res.out).claude_code).toBe("installed");
    expect(await exists(join(p.cwd, ".claude", "settings.local.json"))).toBe(true);
  });

  it("prints the forwardable message for a new invite", async () => {
    const { alice } = await team();
    const res = await alice.cli(["invite"]);
    expect(res.out).toMatch(
      /Join our hailboard board "team": paste this into your coding agent: http\S+\/join\/inv_/,
    );
    const json = JSON.parse((await alice.cli(["invite", "--json"])).out);
    expect(json.invite_message).toContain(json.url);
  });
});
