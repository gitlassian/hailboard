import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { person, serverUrl } from "./helpers.ts";

/**
 * Two people on one machine (one login, one home directory): bob uses the default config
 * folder, alice a folder of her own given with HAILBOARD_CONFIG_DIR when she joined. Coding
 * agents and their hooks are often started without that variable.
 */
async function sharedMachine() {
  const machine = await person("machine");
  const defaultDir = join(machine.home, ".config", "hailboard");
  const aliceDir = join(machine.home, ".config", "hailboard-alice");
  const bobRepo = join(machine.home, "bob-repo");
  const aliceRepo = join(machine.home, "alice-repo");
  await mkdir(bobRepo, { recursive: true });
  await mkdir(aliceRepo, { recursive: true });

  // No HAILBOARD_CONFIG_DIR: the default folder. XDG_CONFIG_HOME keeps it inside the test home.
  const asDefault = { HAILBOARD_CONFIG_DIR: "", XDG_CONFIG_HOME: join(machine.home, ".config") };
  const run = (args: string[], cwd: string, env: Record<string, string> = {}, stdin?: string) =>
    machine.cli(args, { cwd, env: { ...asDefault, ...env }, ...(stdin ? { stdin } : {}) });

  const created = await run(
    [
      "init",
      "--server",
      serverUrl(),
      "--name",
      "shop",
      "--owner",
      "bob",
      "--agent",
      "claude",
      "--json",
    ],
    bobRepo,
  );
  expect(created.code).toBe(0);
  // Bob owns the board and lets alice in without approval: an open invite, made in his terminal.
  const made = await machine.cli(["invite", "--open", "--json"], {
    cwd: bobRepo,
    env: asDefault,
    answers: [],
  });
  expect(made.code).toBe(0);
  const inviteUrl = JSON.parse(made.out).url as string;

  const joined = await run(
    ["init", "--join", inviteUrl, "--owner", "alice", "--agent", "claude"],
    aliceRepo,
    { HAILBOARD_CONFIG_DIR: aliceDir },
  );
  expect(joined.code).toBe(0);
  return { machine, run, defaultDir, aliceDir, bobRepo, aliceRepo, inviteUrl };
}

describe("two people on one machine", () => {
  it("remembers the config folder a project was joined with", async () => {
    const { run, aliceDir, aliceRepo, bobRepo, defaultDir } = await sharedMachine();

    const alice = await run(["me", "--json"], aliceRepo);
    expect(alice.code).toBe(0);
    expect(JSON.parse(alice.out)).toMatchObject({
      member: { handle: "alice" },
      config_dir: aliceDir,
    });
    expect((await run(["me"], aliceRepo)).out).toContain(`config: ${aliceDir}`);

    const bob = await run(["me", "--json"], bobRepo);
    expect(JSON.parse(bob.out)).toMatchObject({
      member: { handle: "bob" },
      config_dir: defaultDir,
    });

    // The mapping lives outside both repositories.
    const folders = JSON.parse(await readFile(join(defaultDir, "folders.json"), "utf8"));
    expect(Object.values(folders.folders)).toEqual([aliceDir]);
  });

  it("delivers each person's messages to their own hooks", async () => {
    const { run, aliceRepo, bobRepo } = await sharedMachine();
    expect((await run(["post", "--as", "agent", "@alice/claude ping"], bobRepo)).code).toBe(0);

    const hook = (cwd: string) =>
      run(
        ["hook", "prompt"],
        cwd,
        {},
        JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd, prompt: "go" }),
      );
    const forAlice = await hook(aliceRepo);
    expect(forAlice.code).toBe(0);
    expect(forAlice.out).toContain("bob/claude → @alice/claude");
    expect((await hook(bobRepo)).out).toBe("");
  });

  it("lets an explicit HAILBOARD_CONFIG_DIR win over the remembered folder", async () => {
    const { run, aliceRepo, defaultDir } = await sharedMachine();
    const res = await run(["me", "--json"], aliceRepo, { HAILBOARD_CONFIG_DIR: defaultDir });
    expect(JSON.parse(res.out).member.handle).toBe("bob");
  });

  it("refuses to join as another person with the config folder of someone else", async () => {
    const { run, machine, inviteUrl } = await sharedMachine();
    const other = join(machine.home, "alice-second-repo");
    await mkdir(other, { recursive: true });

    const res = await run(["init", "--join", inviteUrl, "--owner", "alice"], other);
    expect(res.code).toBe(2);
    expect(res.err).toContain('already on board "shop" as bob');
    expect(res.err).toContain("HAILBOARD_CONFIG_DIR");
  });

  it("warns when git names someone else than the person already on the board", async () => {
    const { run, machine, inviteUrl } = await sharedMachine();
    const other = join(machine.home, "alice-git-repo");
    await mkdir(other, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: other });
    execFileSync("git", ["config", "user.name", "Alice"], { cwd: other });

    const env = { PATH: process.env.PATH ?? "" };
    const res = await run(["init", "--join", inviteUrl, "--agent", "codex"], other, env);
    expect(res.code).toBe(0);
    expect(res.out).toContain('You are already on board "shop" as bob.');
    expect(res.out).toContain('git says you are "alice"');
    expect(res.out).toContain("HAILBOARD_CONFIG_DIR");

    const json = await run(["init", "--json"], other, env);
    expect(JSON.parse(json.out).note).toContain("HAILBOARD_CONFIG_DIR");
  });
});
