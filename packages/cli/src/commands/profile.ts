import type { MemberOut } from "@hailboard/protocol";
import { ApiClient } from "../client.ts";
import type { Command, CommandContext } from "../command.ts";
import { readCredentials } from "../config.ts";
import { formatDay } from "../format.ts";
import { EXIT, UsageError } from "../io.ts";
import { oneLine } from "../printable.ts";
import { connect, requirePerson, stringValue } from "./shared.ts";

const USAGE =
  "hailboard profile [name]                       who a person is: yours, or another's\n" +
  "hailboard profile set [--name TEXT] [--title TEXT] [--tz ZONE] [--here]\n" +
  "\n" +
  "A profile says who a person is on the board: the name they go by, what they do in the team\n" +
  '(--title "frontend") and their time zone (--tz Europe/Kyiv), so others can tell whether it\n' +
  "is night for them. The card also lists the person's agents and what each is working on (its\n" +
  "status). `set` changes your profile on every board this machine is on; --here, only on the\n" +
  'board of this folder. An empty value clears a field: --title "". Only a person can, in\n' +
  "their own terminal.";

const PERSON = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** "15:42" in the person's time zone, or nothing if the zone is unknown here. */
export function localTime(timezone: string, now: Date = new Date()): string | undefined {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(now);
  } catch {
    return undefined;
  }
}

/**
 *   Alice Smith (alice)  frontend  owner
 *   Europe/Kyiv, 15:42 there
 *   ● online, active today 14:02
 *
 *   ● alice/claude  fixing the checkout tests        on laptop
 *   ○ alice/opus    (no status)                      on desktop
 *
 * Machines are mentioned only when the person has more than one.
 */
export function formatProfile(person: MemberOut, agents: MemberOut[], now = new Date()): string {
  const name = person.display_name
    ? `${oneLine(person.display_name)} (${person.handle})`
    : person.handle;
  const head = [
    name,
    person.title ? oneLine(person.title) : "",
    person.role === "owner" ? "owner" : "",
  ]
    .filter(Boolean)
    .join("  ");
  const lines = [head];
  if (person.timezone) {
    const time = localTime(person.timezone, now);
    const zone = oneLine(person.timezone);
    lines.push(time ? `${zone}, ${time} there` : zone);
  }
  const active = person.last_active_at ? `, active ${formatDay(person.last_active_at, now)}` : "";
  lines.push(`${person.online ? "● online" : "○ offline"}${active}`);
  if (person.status_text) lines.push(oneLine(person.status_text));

  if (agents.length > 0) {
    const machines = new Set([person, ...agents].flatMap((m) => m.machines ?? []));
    const width = Math.max(...agents.map((a) => a.handle.length));
    const statusWidth = Math.min(40, Math.max(11, ...agents.map((a) => statusOf(a).length)));
    lines.push("");
    for (const agent of agents) {
      const where =
        machines.size > 1 && agent.machines?.[0] ? `  on ${oneLine(agent.machines[0])}` : "";
      const status = statusOf(agent);
      lines.push(
        `${agent.online ? "●" : "○"} ${agent.handle.padEnd(width)}  ${where ? status.padEnd(statusWidth) : status}${where}`.trimEnd(),
      );
    }
  }
  return lines.join("\n");
}

function statusOf(member: MemberOut): string {
  return member.status_text ? oneLine(member.status_text) : "(no status)";
}

function optionValue(values: CommandContext["values"], name: string): string | null | undefined {
  const raw = stringValue(values, name);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

export const profile: Command = {
  name: "profile",
  summary: "Show who a person is on the board, or set your own profile",
  usage: USAGE,
  options: {
    name: { type: "string" },
    title: { type: "string" },
    tz: { type: "string" },
    here: { type: "boolean" },
  },
  async run(context) {
    const { io, positionals, values } = context;
    if (positionals[0] === "set") return setProfile(context);

    const wanted = positionals[0]?.replace(/^@/, "");
    if (wanted !== undefined && !PERSON.test(wanted.split("/")[0] ?? "")) {
      throw new UsageError(`"${wanted}" is not a name on a board.`);
    }
    for (const option of ["name", "title", "tz"]) {
      if (values[option] !== undefined) {
        throw new UsageError(`--${option} is for \`hailboard profile set\`.`);
      }
    }
    const { client } = await connect(context);
    const [me, listed] = await Promise.all([client.me(), client.members()]);
    // An agent's card is its person's.
    const handle = (wanted ?? me.member.owner).split("/")[0] ?? "";
    const person = listed.members.find((m) => m.handle === handle && m.kind === "human");
    if (!person) throw new UsageError(`Nobody called ${handle} is on this board.`);
    const agents = listed.members.filter((m) => m.handle.startsWith(`${handle}/`));

    if (context.json) {
      io.out(`${JSON.stringify({ person, agents })}\n`);
      return EXIT.ok;
    }
    io.out(`${formatProfile(person, agents)}\n`);
    if (wanted === undefined && !person.display_name && !person.title) {
      io.out('\nSay who you are: hailboard profile set --name "Your Name" --title frontend\n');
    }
    return EXIT.ok;
  },
};

async function setProfile(context: CommandContext): Promise<number> {
  const { io, values } = context;
  const body: { display_name?: string | null; title?: string | null; timezone?: string | null } =
    {};
  const name = optionValue(values, "name");
  const title = optionValue(values, "title");
  const tz = optionValue(values, "tz");
  if (name !== undefined) body.display_name = name;
  if (title !== undefined) body.title = title;
  if (tz !== undefined) body.timezone = tz;
  if (Object.keys(body).length === 0) {
    throw new UsageError("Say what to change: --name, --title or --tz.", `Usage: ${USAGE}`);
  }
  requirePerson(io, "hailboard profile set");

  if (values.here === true) {
    const { client, identity } = await connect({ ...context, role: "human", agent: undefined });
    await client.setProfile(body);
    if (context.json) io.out(`${JSON.stringify({ updated: [identity.boardId], failed: [] })}\n`);
    else io.out(`Profile updated on board "${identity.boardName ?? ""}".\n`);
    return EXIT.ok;
  }

  const boards = Object.entries((await readCredentials(io.env)).boards);
  if (boards.length === 0) {
    throw new UsageError("This machine is on no board yet. Join one first: hailboard init.");
  }
  const updated: string[] = [];
  const failed: { board: string; error: string }[] = [];
  for (const [boardId, credentials] of boards) {
    try {
      await new ApiClient(credentials.server, credentials.human.api_key, io.fetch).setProfile(body);
      updated.push(boardId);
    } catch (error) {
      failed.push({
        board: boardId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (context.json) {
    io.out(`${JSON.stringify({ updated, failed })}\n`);
  } else {
    const where = updated.length === 1 ? "1 board" : `${updated.length} boards`;
    if (updated.length > 0) io.out(`Profile updated on ${where}.\n`);
    for (const f of failed) io.err(`Could not update board ${f.board}: ${f.error}\n`);
  }
  return failed.length > 0 && updated.length === 0 ? EXIT.error : EXIT.ok;
}
