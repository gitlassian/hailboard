import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir } from "./hooks/cache.ts";

/**
 * Which of a person's agents one running session acts as.
 *
 * A person often has two sessions of the same coding tool open at once: two Claude Code windows,
 * maybe in two repositories on the same board. If both act as `alice/claude`, a message to that
 * agent reaches whichever session asks first, and nobody can tell the two apart. So every live
 * session holds an agent name of its own on this machine:
 *
 * 1. the tool's usual name (`claude`), when no other live session holds it;
 * 2. otherwise the model's name (`opus`, `sonnet`), then the model's name with a number
 *    (`opus-2`), when the session said which model it runs;
 * 3. otherwise the tool's name with a number (`claude-2`).
 *
 * A name stays with its session. When the session is gone (its process ended, or it has not been
 * heard from for a while), the next session of the same person takes the name over, so names do
 * not pile up. Names are held per board, in small files under the cache folder.
 */

/** A session that has not used its name for this long counts as gone, when its process is unknown. */
const IDLE_MS = 3 * 3600 * 1000;

const safe = (id: string) => id.replace(/[^A-Za-z0-9._-]+/g, "_");
const boardDir = (env: NodeJS.ProcessEnv, boardId: string) =>
  join(cacheDir(env), "agent-names", safe(boardId));
const metaDir = (env: NodeJS.ProcessEnv) => join(cacheDir(env), "session-meta");

interface Holder {
  session: string;
  /** The coding tool's process, when it says (CLAUDE_PID): the session lives as long as it. */
  pid?: number;
  at: number;
}

interface SessionMeta {
  model?: string;
}

/** The session of the coding agent running this command, from what the tool tells its commands. */
export function sessionOf(env: NodeJS.ProcessEnv, given?: string): string | undefined {
  const id = given ?? env.CLAUDE_CODE_SESSION_ID ?? env.CODEX_THREAD_ID;
  return id && id.trim() !== "" ? id : undefined;
}

/**
 * "claude-opus-5" -> "opus", "claude-sonnet-5-5" -> "sonnet", "gpt-5.5-codex" -> "gpt-5-5".
 * A short name that is valid as the agent part of a handle, or undefined.
 */
export function modelName(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const lower = model.toLowerCase().replace(/\[.*?\]/g, "");
  const family = lower.match(/(opus|sonnet|haiku|fable)/)?.[1];
  if (family) return family;
  const slug = lower
    .replace(/-codex$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "");
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) ? slug : undefined;
}

/** Remembers the model a session runs, as its start hook was told. Never throws. */
export async function noteSessionModel(
  env: NodeJS.ProcessEnv,
  session: string,
  model: string,
): Promise<void> {
  try {
    await mkdir(metaDir(env), { recursive: true });
    const meta: SessionMeta = { model };
    await writeFile(join(metaDir(env), `${safe(session)}.json`), `${JSON.stringify(meta)}\n`);
  } catch {
    // Without it the session gets a number instead of the model's name.
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function alive(holder: Holder, me: Holder, now: number): boolean {
  // One process of the tool runs one session at a time: after /clear the old session is over.
  if (holder.pid !== undefined && holder.pid === me.pid) return false;
  if (holder.pid !== undefined) {
    try {
      process.kill(holder.pid, 0);
      return true;
    } catch (error) {
      // EPERM: the process exists but belongs to someone else.
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }
  return now - holder.at < IDLE_MS;
}

/** The names this session would take, in order. */
export function candidates(base: string, model: string | undefined): string[] {
  const names = [base];
  if (model && model !== base) {
    names.push(model);
    for (let n = 2; n <= 9; n++) names.push(`${model}-${n}`);
  } else {
    for (let n = 2; n <= 9; n++) names.push(`${base}-${n}`);
  }
  return names;
}

/**
 * The agent name `session` acts as on the board, holding it for the session. `base` is the name
 * the session would have alone (the tool's agent). Returns `base` when the names cannot be kept
 * (no cache folder): the old behaviour, one agent for all sessions of a tool.
 */
export async function nameForSession(
  env: NodeJS.ProcessEnv,
  boardId: string,
  session: string,
  base: string,
): Promise<string> {
  const dir = boardDir(env, boardId);
  const now = Date.now();
  const pid = Number(env.CLAUDE_PID);
  const me: Holder = { session, at: now, ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}) };
  try {
    await mkdir(dir, { recursive: true });
    const meta = await readJson<SessionMeta>(join(metaDir(env), `${safe(session)}.json`));
    const model = modelName(meta?.model);
    const names = candidates(base, model);

    // A name this session already holds stays its own.
    for (const name of names) {
      const holder = await readJson<Holder>(join(dir, `${name}.json`));
      if (holder?.session === session) {
        await writeFile(join(dir, `${name}.json`), `${JSON.stringify(me)}\n`);
        return name;
      }
    }
    for (const name of names) {
      const path = join(dir, `${name}.json`);
      const holder = await readJson<Holder>(path);
      if (holder && holder.session !== session && alive(holder, me, now)) continue;
      if (holder) await rm(path, { force: true });
      try {
        // "wx": only one of two sessions starting at the same moment gets the name.
        await writeFile(path, `${JSON.stringify(me)}\n`, { flag: "wx" });
        return name;
      } catch {
        // Taken a moment ago by another session: try the next name.
      }
    }
  } catch {
    // No cache folder: fall back to one agent for every session of the tool.
  }
  return base;
}
