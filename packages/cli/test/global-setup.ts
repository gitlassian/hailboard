import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    serverUrl: string;
  }
}

const SERVER_DIR = join(import.meta.dirname, "..", "..", "server");

/** Starts the Python server on a throwaway database and waits until it is ready. */
export default async function setup(project: TestProject) {
  const child: ChildProcess = spawn("uv", ["run", "python", "scripts/serve_for_tests.py"], {
    cwd: SERVER_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`The test server did not start in time.\n${stderr}`)),
      60_000,
    );
    let buffer = "";
    child.stdout?.on("data", (chunk) => {
      buffer += String(chunk);
      const match = /READY (\d+)/.exec(buffer);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `The test server exited with code ${code}. Is PostgreSQL running ("pnpm db:up")?\n${stderr}`,
        ),
      );
    });
  });

  project.provide("serverUrl", `http://127.0.0.1:${port}`);

  return async () => {
    child.removeAllListeners("exit");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await exited;
  };
}
