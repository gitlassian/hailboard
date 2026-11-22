import { homedir } from "node:os";
import { join } from "node:path";

/** Where the hooks keep small files: throttling marks, wake locks, session folders. */
export function cacheDir(env: NodeJS.ProcessEnv): string {
  if (env.HAILBOARD_CACHE_DIR) return env.HAILBOARD_CACHE_DIR;
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, "hailboard");
  return join(env.HOME ?? homedir(), ".cache", "hailboard");
}
