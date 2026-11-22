import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inject } from "vitest";
import { run } from "../src/cli.ts";
import type { Confirmation } from "../src/io.ts";

export interface Result {
  code: number;
  out: string;
  err: string;
}

export interface RunOptions {
  stdin?: string;
  /** Answers to interactive questions, in order. Makes the run interactive. */
  answers?: string[];
  env?: Record<string, string>;
  fetch?: typeof fetch;
  /** Run in another directory than the person's repository (a second repository, say). */
  cwd?: string;
  /**
   * What the person answers in the confirmation window. Without it no window can be shown.
   * A function also receives the question, to look at what the person was asked.
   */
  confirm?: "yes" | "no" | ((question: Confirmation) => "yes" | "no" | "unavailable");
  /** Standard output is a terminal a person reads, not a pipe. */
  terminal?: boolean;
}

/** One person on one machine: their own repository directory and their own key store. */
export interface Person {
  name: string;
  /** The repository directory the person works in. */
  cwd: string;
  /** Where this person's credentials are stored. */
  configDir: string;
  /** This person's home directory (never the real one). */
  home: string;
  /** Where hooks remember when they last checked. */
  cacheDir: string;
  cli: (args: string[], options?: RunOptions) => Promise<Result>;
  /** Credentials file content. */
  credentials: () => Promise<{ boards: Record<string, Record<string, unknown>> }>;
}

async function* linesOf(text: string): AsyncGenerator<string> {
  for (const line of text.split("\n")) if (line !== "") yield line;
}

export const serverUrl = () => inject("serverUrl");

export async function person(name: string): Promise<Person> {
  const root = await mkdtemp(join(tmpdir(), `hailboard-${name}-`));
  const cwd = join(root, "repo");
  const configDir = join(root, "config");
  const home = join(root, "home");
  const cacheDir = join(root, "cache");
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });

  const cli: Person["cli"] = async (args, options = {}) => {
    let out = "";
    let err = "";
    const answers = [...(options.answers ?? [])];
    const code = await run(args, {
      env: {
        HAILBOARD_CONFIG_DIR: configDir,
        HAILBOARD_CACHE_DIR: cacheDir,
        HOME: home,
        USER: name,
        ...options.env,
      },
      cwd: options.cwd ?? cwd,
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
      readStdin: async () => options.stdin ?? "",
      readLines: () => linesOf(options.stdin ?? ""),
      ask: async (_question, defaultValue) => answers.shift() ?? defaultValue ?? "",
      interactive: options.answers !== undefined,
      terminal: options.terminal === true,
      confirm: async (question) => {
        if (options.confirm === undefined) return "unavailable";
        return typeof options.confirm === "function" ? options.confirm(question) : options.confirm;
      },
      fetch: options.fetch ?? fetch,
    });
    return { code, out, err };
  };

  return {
    name,
    cwd,
    configDir,
    home,
    cacheDir,
    cli,
    credentials: async () =>
      JSON.parse(await readFile(join(configDir, "credentials.json"), "utf8")),
  };
}

/**
 * The number of the first message posted on a board made by `team()`: #1 and #2 are the activity
 * events of Alice creating the board and Bob joining it.
 */
export const FIRST = 3;

/** Alice creates a board with her agent (claude); Bob joins it with his (codex by default). */
export async function team(options: { bobAgent?: string } = {}) {
  const alice = await person("alice");
  const created = await alice.cli([
    "init",
    "--server",
    serverUrl(),
    "--name",
    "team",
    "--owner",
    "alice",
    "--agent",
    "claude",
    "--json",
  ]);
  if (created.code !== 0) throw new Error(`alice init failed: ${created.err}`);
  // The invite made with the board needs alice's approval for each newcomer. Most tests are not
  // about that: alice, the owner, makes an open invite in her terminal, and bob comes with it.
  const { invite_url: boardInvite } = JSON.parse(created.out) as { invite_url: string };
  const made = await alice.cli(["invite", "--open", "--json"], { answers: [] });
  if (made.code !== 0) throw new Error(`alice invite --open failed: ${made.err}`);
  const { url: inviteUrl } = JSON.parse(made.out) as { url: string };

  const bob = await person("bob");
  const joined = await bob.cli([
    "init",
    "--join",
    inviteUrl,
    "--owner",
    "bob",
    "--agent",
    options.bobAgent ?? "codex",
  ]);
  if (joined.code !== 0) throw new Error(`bob init failed: ${joined.err}`);

  return { alice, bob, inviteUrl, boardInvite };
}

export async function writeFileIn(dir: string, name: string, content: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), content);
}
