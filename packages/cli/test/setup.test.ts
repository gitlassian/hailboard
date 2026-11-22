import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SKILL_MARKER, SKILL_TEXT } from "../src/adapters/claude-code/skill.ts";
import { person, serverUrl } from "./helpers.ts";

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const userSettings = (home: string) => join(home, ".claude", "settings.json");
const skillFile = (home: string) => join(home, ".claude", "skills", "hailboard", "SKILL.md");

type Hooks = Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
const hooksOf = async (home: string): Promise<Hooks> =>
  JSON.parse(await readFile(userSettings(home), "utf8")).hooks;

describe("hailboard setup", () => {
  it("installs the hooks for all projects and the skill", async () => {
    const p = await person("sam");
    const res = await p.cli(["setup"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Claude Code\n  Hooks: installed in");
    expect(res.out).toContain("SessionStart, UserPromptSubmit, PostToolUse, Stop, wake");
    expect(res.out).toContain("Skill: installed");
    expect(res.out).toContain("paste an hailboard invite link");

    const hooks = await hooksOf(p.home);
    expect(Object.keys(hooks).sort()).toEqual(
      ["PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"].sort(),
    );
    expect(hooks.Stop?.[0]?.hooks.map((h) => h.asyncRewake === true)).toEqual([false, true]);

    const skill = await readFile(skillFile(p.home), "utf8");
    expect(skill).toBe(SKILL_TEXT);
    expect(skill.startsWith("---\nname: hailboard\ndescription: ")).toBe(true);
    expect(skill).toContain("/join/inv_");
  });

  it("changes nothing when run again", async () => {
    const p = await person("sam");
    await p.cli(["setup"]);
    const before = await readFile(userSettings(p.home), "utf8");
    const res = await p.cli(["setup"]);
    expect(res.out).toContain("Hooks: already installed");
    expect(res.out).toContain("Skill: already up to date");
    expect(await readFile(userSettings(p.home), "utf8")).toBe(before);
  });

  it("keeps the user's own settings and a skill it did not write", async () => {
    const p = await person("sam");
    await mkdir(join(p.home, ".claude", "skills", "hailboard"), { recursive: true });
    await writeFile(skillFile(p.home), "my own notes\n");
    await writeFile(userSettings(p.home), '{ "model": "opus" }\n');

    const res = await p.cli(["setup"]);
    expect(res.out).toContain("Skill: skipped");
    expect(await readFile(skillFile(p.home), "utf8")).toBe("my own notes\n");
    expect(JSON.parse(await readFile(userSettings(p.home), "utf8")).model).toBe("opus");

    await p.cli(["setup", "--remove"]);
    expect(await readFile(skillFile(p.home), "utf8")).toBe("my own notes\n");
    expect(JSON.parse(await readFile(userSettings(p.home), "utf8"))).toEqual({ model: "opus" });
  });

  it("updates an outdated skill of its own", async () => {
    const p = await person("sam");
    await mkdir(join(p.home, ".claude", "skills", "hailboard"), { recursive: true });
    await writeFile(skillFile(p.home), `old version\n${SKILL_MARKER}\n`);
    const res = await p.cli(["setup", "--no-wake"]);
    expect(res.out).toContain("Skill: updated");
    expect(await readFile(skillFile(p.home), "utf8")).toBe(SKILL_TEXT);
    expect((await hooksOf(p.home)).Stop?.[0]?.hooks).toHaveLength(1);
  });

  it("reports its state", async () => {
    const p = await person("sam");
    const before = JSON.parse((await p.cli(["setup", "--status", "--json"])).out);
    expect(before).toMatchObject({ hooks: [], wake: false, skill: "missing" });

    await p.cli(["setup"]);
    const after = JSON.parse((await p.cli(["setup", "--status", "--json"])).out);
    expect(after).toMatchObject({ wake: true, skill: "current" });
    expect(after.hooks).toHaveLength(4);
    expect((await p.cli(["setup", "--status"])).out).toContain("Skill: installed");
  });

  it("removes everything it added", async () => {
    const p = await person("sam");
    await p.cli(["setup"]);
    const res = await p.cli(["setup", "--remove"]);
    expect(res.out).toContain("Removed 5 hailboard hooks");
    expect(res.out).toContain("Removed the skill");
    expect(await exists(skillFile(p.home))).toBe(false);
    expect(await exists(userSettings(p.home))).toBe(false); // it did not exist before
  });

  it("writes nothing on a dry run", async () => {
    const p = await person("sam");
    const res = await p.cli(["setup", "--dry-run"]);
    expect(res.out).toContain("Hooks: would be installed");
    expect(res.out).toContain("Skill: would be written");
    expect(await exists(userSettings(p.home))).toBe(false);
    expect(await exists(skillFile(p.home))).toBe(false);
  });

  it("makes init skip the per-project hooks", async () => {
    const p = await person("sam");
    await p.cli(["setup"]);
    const res = await p.cli([
      "init",
      "--server",
      serverUrl(),
      "--name",
      "solo",
      "--owner",
      "sam",
      "--claude-code",
    ]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("already active for all your projects");
    expect(await exists(join(p.cwd, ".claude", "settings.local.json"))).toBe(false);
  });

  it("stops claude-code install from adding the hooks a second time", async () => {
    const p = await person("sam");
    await p.cli(["setup"]);
    const res = await p.cli(["claude-code", "install"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("already installed for all your projects");
    expect(await exists(join(p.cwd, ".claude", "settings.local.json"))).toBe(false);
  });
});
