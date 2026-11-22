import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isManaged } from "../src/adapters/claude-code/settings.ts";
import { installSkill, skillPath } from "../src/adapters/claude-code/skill.ts";
import { installCodexMcp } from "../src/adapters/codex/config.ts";
import { adoptLegacyConfig, findRepoConfig } from "../src/config.ts";

/** What a machine set up before the project was renamed (agentbridge) still has. */
describe("installs from before the rename", () => {
  it("moves the old config folder, keys and all, to the new place once", async () => {
    const home = await mkdtemp(join(tmpdir(), "hb-legacy-"));
    const old = join(home, ".config", "agentbridge");
    await mkdir(old, { recursive: true });
    await writeFile(join(old, "credentials.json"), '{"boards":{}}');

    await adoptLegacyConfig({ HOME: home });
    expect(await readFile(join(home, ".config", "hailboard", "credentials.json"), "utf8")).toBe(
      '{"boards":{}}',
    );
    await expect(stat(old)).rejects.toThrow();

    // A new folder that already exists is never replaced.
    await mkdir(old, { recursive: true });
    await writeFile(join(old, "credentials.json"), "stale");
    await adoptLegacyConfig({ HOME: home });
    expect(await readFile(join(home, ".config", "hailboard", "credentials.json"), "utf8")).toBe(
      '{"boards":{}}',
    );
  });

  it("reads a repository's .agentbridge.json", async () => {
    const repo = await mkdtemp(join(tmpdir(), "hb-repo-"));
    const config = { server: "https://example.test", board_id: "brd_1", board_name: "team" };
    await writeFile(join(repo, ".agentbridge.json"), JSON.stringify(config));
    await mkdir(join(repo, "src"));
    expect((await findRepoConfig(join(repo, "src")))?.config).toEqual(config);
  });

  it("takes the old hooks, Codex table and skill as its own and replaces them", async () => {
    expect(isManaged({ command: "agentbridge hook stop # agentbridge-managed" })).toBe(true);
    expect(isManaged({ command: "my-own-hook" })).toBe(false);

    const home = await mkdtemp(join(tmpdir(), "hb-setup-"));
    const env = { HOME: home, CODEX_HOME: join(home, ".codex") };
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      join(home, ".codex", "config.toml"),
      [
        'model = "gpt-5"',
        "",
        "# agentbridge-managed: the agentbridge MCP server",
        "[mcp_servers.agentbridge]",
        'command = "agentbridge"',
        'args = ["mcp", "--agent", "codex"]',
        "tool_timeout_sec = 120",
        "",
      ].join("\n"),
    );
    await installCodexMcp(env, { command: "hailboard", dryRun: false });
    const toml = await readFile(join(home, ".codex", "config.toml"), "utf8");
    expect(toml).toContain('model = "gpt-5"');
    expect(toml).toContain("[mcp_servers.hailboard]");
    expect(toml).not.toContain("agentbridge");

    const oldSkill = join(home, ".claude", "skills", "agentbridge", "SKILL.md");
    await mkdir(join(home, ".claude", "skills", "agentbridge"), { recursive: true });
    await writeFile(oldSkill, "<!-- agentbridge-managed: re-run `agentbridge setup` -->");
    await installSkill(env, { dryRun: false });
    await expect(stat(oldSkill)).rejects.toThrow();
    expect(await readFile(skillPath(env), "utf8")).toContain("hailboard-managed");
  });
});
