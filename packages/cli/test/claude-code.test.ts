import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MARKER } from "../src/adapters/claude-code/settings.ts";
import { person, serverUrl } from "./helpers.ts";

const settingsOf = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const localFile = (cwd: string) => join(cwd, ".claude", "settings.local.json");
const backupOf = (text: string) => /saved at (\S+)/.exec(text)?.[1] ?? "";

/** A repository that is connected to a board, with an agent. */
async function connected(name = "alice") {
  const p = await person(name);
  await mkdir(join(p.cwd, ".git"), { recursive: true });
  const res = await p.cli(["init", "--server", serverUrl(), "--owner", name, "--agent", "claude"]);
  expect(res.code).toBe(0);
  return p;
}

describe("claude-code install", () => {
  it("creates the personal settings file, keeps it out of git and can be undone", async () => {
    const p = await connected();
    const res = await p.cli(["claude-code", "install"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("hooks: SessionStart, UserPromptSubmit, PostToolUse, Stop");
    expect(res.out).toContain("did not exist before");
    expect(res.out).toContain("Added .claude/settings.local.json to .gitignore");

    const settings = await settingsOf(localFile(p.cwd));
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      `hailboard hook prompt ${MARKER}`,
    );
    expect(await readFile(join(p.cwd, ".gitignore"), "utf8")).toContain(
      ".claude/settings.local.json",
    );

    // The file did not exist before hailboard, so undoing it removes the file again.
    const undone = await p.cli(["claude-code", "uninstall"]);
    expect(undone.out).toContain("it was deleted");
    await expect(stat(localFile(p.cwd))).rejects.toThrow();
  });

  it("adds to existing settings, saves the original first and keeps the file's style", async () => {
    const p = await connected();
    const original = `{
    "model": "opus",
    "hooks": {
        "PostToolUse": [
            { "matcher": "Edit", "hooks": [{ "type": "command", "command": "./lint.sh" }] }
        ]
    }
}
`;
    await mkdir(join(p.cwd, ".claude"), { recursive: true });
    await writeFile(localFile(p.cwd), original);
    await chmod(localFile(p.cwd), 0o600);

    const res = await p.cli(["claude-code", "install"]);
    expect(res.code).toBe(0);

    // The backup is byte for byte the original, and lives outside the repository.
    const backup = backupOf(res.out);
    expect(backup).toContain(p.configDir);
    expect(await readFile(backup, "utf8")).toBe(original);

    const text = await readFile(localFile(p.cwd), "utf8");
    expect(text).toContain('\n    "model": "opus"'); // 4-space indentation kept
    const settings = JSON.parse(text);
    expect(settings.model).toBe("opus");
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe("./lint.sh"); // theirs, first and unchanged
    expect(settings.hooks.PostToolUse).toHaveLength(2);
    expect((await stat(localFile(p.cwd))).mode & 0o777).toBe(0o600);
  });

  it("does nothing the second time", async () => {
    const p = await connected();
    await p.cli(["claude-code", "install"]);
    const before = await readFile(localFile(p.cwd), "utf8");
    const backups = await readdir(join(p.configDir, "backups")).catch(() => []);

    const again = await p.cli(["claude-code", "install"]);
    expect(again.out).toContain("already installed");
    expect(await readFile(localFile(p.cwd), "utf8")).toBe(before);
    expect(await readdir(join(p.configDir, "backups")).catch(() => [])).toEqual(backups);
  });

  it("shows what it would do with --dry-run and changes nothing", async () => {
    const p = await connected();
    const res = await p.cli(["claude-code", "install", "--dry-run"]);
    expect(res.out).toContain("Would create");
    await expect(stat(localFile(p.cwd))).rejects.toThrow();
  });

  it("refuses a file that is not valid JSON and leaves it alone", async () => {
    const p = await connected();
    await mkdir(join(p.cwd, ".claude"), { recursive: true });
    await writeFile(localFile(p.cwd), '{ "model": "opus", // comment\n}');
    const res = await p.cli(["claude-code", "install"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("not valid JSON");
    expect(await readFile(localFile(p.cwd), "utf8")).toContain("// comment");
  });

  it("can install without the Stop hook", async () => {
    const p = await connected();
    const res = await p.cli(["claude-code", "install", "--no-stop"]);
    expect(res.out).toContain("hooks: SessionStart, UserPromptSubmit, PostToolUse");
    expect(res.out).not.toContain("Stop");
  });

  it("supports shared and user scopes", async () => {
    const p = await connected();
    const shared = await p.cli(["claude-code", "install", "--scope", "shared"]);
    expect(shared.out).toContain(join(p.cwd, ".claude", "settings.json"));
    const user = await p.cli(["claude-code", "install", "--scope", "user"]);
    expect(user.out).toContain(join(p.home, ".claude", "settings.json"));
    expect((await settingsOf(join(p.home, ".claude", "settings.json"))).hooks.Stop).toBeDefined();
    expect((await p.cli(["claude-code", "install", "--scope", "nowhere"])).code).toBe(2);
  });

  it("warns when the command is not on PATH, and not when it is", async () => {
    const p = await connected();
    const missing = await p.cli(["claude-code", "install"], { env: { PATH: "/nonexistent" } });
    expect(missing.out).toContain("is not on your PATH");

    const bin = join(p.home, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "hailboard"), "#!/bin/sh\n");
    await chmod(join(bin, "hailboard"), 0o755);
    const found = await p.cli(["claude-code", "install", "--dry-run"], { env: { PATH: bin } });
    expect(found.out).not.toContain("not on your PATH");
  });

  it("supports a custom command (for example a path while developing)", async () => {
    const p = await connected();
    await p.cli(["claude-code", "install", "--command", "node /opt/hailboard.js"]);
    const settings = await settingsOf(localFile(p.cwd));
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(
      `node /opt/hailboard.js hook stop ${MARKER}`,
    );
  });
});

describe("backups", () => {
  it("never overwrite each other, even when made in the same millisecond", async () => {
    const p = await connected();
    const original = '{ "marker": "original" }\n';
    await mkdir(join(p.cwd, ".claude"), { recursive: true });
    await writeFile(localFile(p.cwd), original);
    const first = await p.cli(["claude-code", "install"]);

    // Make backups as fast as possible: repeated install/uninstall cycles.
    const saved = new Set<string>();
    for (let i = 0; i < 8; i++) {
      await p.cli(["claude-code", "uninstall"]);
      await p.cli(["claude-code", "install"]);
    }
    for (const name of await readdir(join(p.configDir, "backups"))) saved.add(name);

    // The first backup is still the original, untouched.
    expect(await readFile(backupOf(first.out), "utf8")).toBe(original);
    expect(saved.size).toBeGreaterThanOrEqual(8);
  });
});

describe("claude-code uninstall", () => {
  it("removes only its hooks and keeps everything else", async () => {
    const p = await connected();
    const original =
      '{\n  "model": "opus",\n  "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "./done.sh" }] }] }\n}\n';
    await mkdir(join(p.cwd, ".claude"), { recursive: true });
    await writeFile(localFile(p.cwd), original);
    await p.cli(["claude-code", "install"]);

    const res = await p.cli(["claude-code", "uninstall"]);
    expect(res.out).toContain("Removed 5 hailboard hooks");
    expect(await settingsOf(localFile(p.cwd))).toEqual(JSON.parse(original));
  });

  it("puts the original file back exactly with --restore-backup, saving what was there", async () => {
    const p = await connected();
    const original = '{\t"theme":\t"dark"  ,\n\n"hooks":{}}\n'; // odd formatting on purpose
    await mkdir(join(p.cwd, ".claude"), { recursive: true });
    await writeFile(localFile(p.cwd), original);
    await p.cli(["claude-code", "install"]);

    // The user keeps editing after the install.
    const edited = JSON.parse(await readFile(localFile(p.cwd), "utf8"));
    edited.model = "sonnet";
    await writeFile(localFile(p.cwd), JSON.stringify(edited));

    const res = await p.cli(["claude-code", "uninstall", "--restore-backup"]);
    expect(res.out).toContain("how it was before hailboard");
    expect(await readFile(localFile(p.cwd), "utf8")).toBe(original);
    // What was there before restoring is kept too, so no edit is lost.
    expect(await readFile(backupOf(res.out), "utf8")).toContain('"model":"sonnet"');
  });

  it("deletes a file that did not exist before when restoring", async () => {
    const p = await connected();
    await p.cli(["claude-code", "install"]);
    const res = await p.cli(["claude-code", "uninstall", "--restore-backup", "--scope", "project"]);
    expect(res.code).toBe(0);
    await expect(stat(localFile(p.cwd))).rejects.toThrow();
  });

  it("says so when there is nothing to remove, and explains --restore-backup on a file it never touched", async () => {
    const p = await connected();
    expect((await p.cli(["claude-code", "uninstall"])).out).toContain("Nothing to remove");
    const res = await p.cli(["claude-code", "uninstall", "--restore-backup", "--scope", "shared"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("never changed it");
  });

  it("finds hooks in every scope when no scope is given", async () => {
    const p = await connected();
    await p.cli(["claude-code", "install", "--scope", "project"]);
    await p.cli(["claude-code", "install", "--scope", "user"]);
    const res = await p.cli(["claude-code", "uninstall"]);
    expect(res.out).toContain(localFile(p.cwd));
    expect(res.out).toContain(join(p.home, ".claude", "settings.json"));
  });
});

describe("claude-code status", () => {
  it("shows where the hooks are installed", async () => {
    const p = await connected();
    expect((await p.cli(["claude-code", "status"])).out).toMatch(/project\s+no file/);
    await p.cli(["claude-code", "install"]);
    const status = await p.cli(["claude-code", "status"]);
    expect(status.out).toMatch(
      /project\s+installed \(SessionStart, UserPromptSubmit, PostToolUse, Stop, wake\)/,
    );
    expect(status.out).toMatch(/shared\s+no file/);
    expect(JSON.parse((await p.cli(["claude-code", "status", "--json"])).out)).toHaveLength(3);
  });

  it("needs an action", async () => {
    const p = await connected();
    expect((await p.cli(["claude-code"])).code).toBe(2);
    expect((await p.cli(["claude-code", "frobnicate"])).code).toBe(2);
  });
});

describe("init and Claude Code", () => {
  it("installs the hooks with --claude-code", async () => {
    const p = await person("alice");
    const res = await p.cli([
      "init",
      "--server",
      serverUrl(),
      "--owner",
      "alice",
      "--agent",
      "claude",
      "--claude-code",
    ]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Claude Code hooks installed");
    expect((await settingsOf(localFile(p.cwd))).hooks.SessionStart).toBeDefined();
  });

  it("asks a person, and a no changes nothing", async () => {
    const yes = await person("alice");
    const accepted = await yes.cli(["init"], {
      answers: [serverUrl(), "alice", "claude", "board", "y"],
    });
    expect(accepted.out).toContain("Claude Code hooks installed");

    const no = await person("bob");
    const declined = await no.cli(["init"], {
      answers: [serverUrl(), "bob", "codex", "board", "n"],
    });
    expect(declined.out).toContain("hailboard setup (once per machine)");
    await expect(stat(localFile(no.cwd))).rejects.toThrow();
  });

  it("does not install anything by default when nobody can be asked", async () => {
    const p = await person("alice");
    await p.cli(["init", "--server", serverUrl(), "--owner", "alice", "--agent", "claude"]);
    await expect(stat(localFile(p.cwd))).rejects.toThrow();
  });
});
