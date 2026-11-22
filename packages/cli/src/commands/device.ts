import { hostname } from "node:os";
import type { Command } from "../command.ts";
import { readCredentials, saveBoardCredentials } from "../config.ts";
import { EXIT, UsageError } from "../io.ts";
import { connect, requirePerson } from "./shared.ts";

const USAGE =
  "hailboard device add [--name NAME]   a one-time code for another machine of yours\n" +
  "hailboard device list                your machines on this board\n" +
  "hailboard device remove <name>       stop the keys of one machine\n" +
  "\n" +
  "One person, several machines. Run `device add` on a machine that is on the board and run what\n" +
  "it prints on the other one: `hailboard init --device <link>`. The other machine gets keys of\n" +
  "its own for you and your agents, so you do not join a second time and wait for the owner.\n" +
  "The code works once, for 10 minutes. --name says what to call this machine (default: its host\n" +
  "name). Only a person can, in their own terminal.";

/** A name for this machine that the board accepts: its host name, without ".local". */
export function machineName(given?: string): string {
  const raw = (given ?? hostname()).trim().replace(/\.local$/i, "");
  const name = raw.replace(/\s+/g, " ").slice(0, 64);
  if (name === "") throw new UsageError("Give the machine a name: --name <name>.");
  return name;
}

export const device: Command = {
  name: "device",
  summary: "Bring another machine of yours onto the board, list or remove machines",
  usage: USAGE,
  options: { name: { type: "string" } },
  async run(context) {
    const { io, positionals, values } = context;
    const [action = "list", ...rest] = positionals;
    if (action !== "add" && action !== "list" && action !== "remove") {
      throw new UsageError(`Unknown action "${action}".`, `Usage: ${USAGE}`);
    }
    const shown =
      action === "remove"
        ? `hailboard device remove ${rest[0] ?? "<name>"}`
        : `hailboard device ${action}`;
    requirePerson(io, shown);
    const { client, identity } = await connect({ ...context, role: "human", agent: undefined });

    if (action === "add") {
      // This machine gets a name first, if it has none, so that it can be told apart later.
      const stored = identity.boardId
        ? (await readCredentials(io.env)).boards[identity.boardId]
        : undefined;
      const here =
        stored?.device ?? machineName(typeof values.name === "string" ? values.name : undefined);
      const made = await client.makeDeviceCode(stored?.device ? undefined : here);
      if (stored && identity.boardId && !stored.device) {
        await saveBoardCredentials(io.env, identity.boardId, { ...stored, device: here });
      }
      if (context.json) {
        io.out(`${JSON.stringify({ ...made, this_device: here })}\n`);
        return EXIT.ok;
      }
      io.out(
        "On your other machine, run:\n\n" +
          `  hailboard init --device ${made.url}\n\n` +
          "The code works once, in the next 10 minutes. Do not share it: it gives that machine\n" +
          `your keys on board "${identity.boardName ?? "?"}".\n`,
      );
      return EXIT.ok;
    }

    if (action === "remove") {
      const name = rest[0];
      if (!name)
        throw new UsageError("Say which machine.", "Usage: hailboard device remove <name>");
      await client.removeDevice(name);
      if (context.json) io.out(`${JSON.stringify({ removed: name })}\n`);
      else io.out(`Stopped the keys of "${name}". That machine is no longer on the board.\n`);
      return EXIT.ok;
    }

    const { devices } = await client.devices();
    if (context.json) {
      io.out(`${JSON.stringify({ devices })}\n`);
      return EXIT.ok;
    }
    const label = (d: (typeof devices)[number]) => d.name ?? "(first machine, no name yet)";
    const width = Math.max(...devices.map((d) => label(d).length));
    for (const d of devices) {
      const used = d.last_used_at
        ? `used ${d.last_used_at.slice(0, 16).replace("T", " ")}`
        : "not used yet";
      io.out(`${label(d).padEnd(width)}  ${used}${d.current ? "  (this one)" : ""}\n`);
    }
    return EXIT.ok;
  },
};
