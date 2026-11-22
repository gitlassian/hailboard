import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "protocol",
          include: ["packages/protocol/test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "web",
          include: ["packages/web/test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "cli",
          include: ["packages/cli/test/**/*.test.ts"],
          // Starts the Python server on a throwaway database (needs `pnpm db:up` and uv).
          globalSetup: ["packages/cli/test/global-setup.ts"],
          environment: "node",
          // Each test file talks to the same server; keep them from racing on shared state.
          fileParallelism: false,
        },
      },
    ],
  },
});
