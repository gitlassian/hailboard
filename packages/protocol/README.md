# @hailboard/protocol

The TypeScript side of the API contract, used by the CLI and the web feed.

- **`src/api.ts` is generated** from the server's OpenAPI description (`openapi.json`). Do not edit it. After changing the server's API, run `pnpm gen:api` from the repository root and commit the result; CI fails if they are out of date.
- `src/index.ts` exports friendly names for the generated types (`Message`, `InboxResult`, ...).
- `src/handle.ts` validates handles (`alice`, `alice/claude`) the same way the server does, so the CLI can reject typos before calling it.
- `src/constants.ts` holds the limits enforced by the server.
- `src/invite.ts` builds the invite message a person forwards, so the CLI and the invite page say the same.

The server (Python, `packages/server`) is the source of truth for the contract.
