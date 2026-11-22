import { describe, expect, it } from "vitest";
import { type Person, person, team } from "./helpers.ts";

/** In a terminal of their own: what `requirePerson` asks for. */
const TERMINAL = { answers: [] as string[] };

/** Carol joins with the invite made with the board, which needs alice's approval. */
async function carolAsks(boardInvite: string): Promise<Person> {
  const carol = await person("carol");
  const joined = await carol.cli(["init", "--join", boardInvite, "--owner", "carol"]);
  expect(joined.code).toBe(0);
  expect(joined.out).toContain("You asked to join. alice decides");
  expect(joined.out).toContain("hailboard accept carol");
  expect(joined.out).not.toContain("Watch the board in your browser");
  return carol;
}

describe("letting people in", () => {
  it("makes a newcomer wait until the owner accepts them", async () => {
    const { alice, boardInvite } = await team();
    const carol = await carolAsks(boardInvite);

    const blocked = await carol.cli(["inbox"]);
    expect(blocked.code).toBe(1);
    expect(blocked.err).toContain("alice has not let you onto this board yet");

    const members = await alice.cli(["members"]);
    expect(members.out).toMatch(/● alice +owner/);
    expect(members.out).toContain("Waiting to join (only alice can let them in");
    expect(members.out).toMatch(/carol +with carol\/claude +asked today/);

    // Alice's agent hears of it, and cannot let carol in.
    const told = await alice.cli(["inbox", "--as", "agent"]);
    expect(told.out).toContain("carol asks to join with the agent carol/claude");
    const byAgent = await alice.cli(["accept", "carol"]);
    expect(byAgent.code).toBe(1);
    expect(byAgent.err).toContain("Only a person can do this");
    expect(byAgent.err).toContain("hailboard accept carol");

    const accepted = await alice.cli(["accept", "carol"], TERMINAL);
    expect(accepted.code).toBe(0);
    expect(accepted.out).toContain("carol is on the board now");
    const welcome = await carol.cli(["inbox", "--as", "agent"]);
    expect(welcome.out).toContain("alice let carol and carol/claude onto the board.");
  });

  it("lets only the owner accept, and turns people down", async () => {
    const { alice, bob, boardInvite } = await team();
    const carol = await carolAsks(boardInvite);
    const notOwner = await bob.cli(["accept", "carol"], TERMINAL);
    expect(notOwner.code).toBe(1);
    expect(notOwner.err).toContain("only the board's owner can let people in");

    expect((await alice.cli(["decline", "carol"], TERMINAL)).code).toBe(0);
    const gone = await carol.cli(["inbox"]);
    expect(gone.err).toContain("you are no longer on this board");
  });

  it("tells a waiting agent at the start of a session", async () => {
    const { boardInvite } = await team();
    const carol = await carolAsks(boardInvite);
    const res = await carol.cli(["hook", "session-start"], {
      stdin: JSON.stringify({ hook_event_name: "SessionStart", session_id: "s", cwd: carol.cwd }),
    });
    const context = JSON.parse(res.out).hookSpecificOutput.additionalContext as string;
    expect(context).toContain("alice has not let you in yet");
    expect(context).toContain("hailboard accept carol");
  });
});

describe("taking people off and leaving", () => {
  it("takes a person off with their agents, and a person their own agent", async () => {
    const { alice, bob } = await team();
    expect((await bob.cli(["remove", "alice/claude"], TERMINAL)).code).toBe(1);
    expect((await bob.cli(["remove", "bob/codex"], TERMINAL)).code).toBe(0);
    const gone = await bob.cli(["inbox", "--as", "agent", "--agent", "codex"]);
    expect(gone.err).toContain("no longer on this board");
    // Only bob brings it back, in his own terminal.
    expect((await bob.cli(["init", "--agent", "codex"])).err).toContain("Only a person");
    const back = await bob.cli(["init", "--agent", "codex"], TERMINAL);
    expect(back.out).toContain("Added your agent bob/codex");
    expect((await bob.cli(["inbox", "--as", "agent", "--agent", "codex"])).code).toBe(0);

    const removed = await alice.cli(["remove", "bob"], TERMINAL);
    expect(removed.out).toContain("Took bob and their agents off the board");
    expect((await bob.cli(["inbox"])).err).toContain("no longer on this board");
    expect((await alice.cli(["members"])).out).not.toContain("bob");
  });

  it("lets a person leave, but not the owner", async () => {
    const { alice, bob } = await team();
    const owner = await alice.cli(["leave"], TERMINAL);
    expect(owner.err).toContain("hand the board over first");
    expect((await bob.cli(["leave"], TERMINAL)).out).toContain('You left the board "team"');
    // The keys are gone from bob's machine.
    expect((await bob.cli(["inbox"])).err).not.toContain("no longer on this board");
  });

  it("joins again under a new name after being taken off", async () => {
    const { alice, bob } = await team();
    const invite = JSON.parse((await alice.cli(["invite", "--open", "--json"], TERMINAL)).out);
    await alice.cli(["remove", "bob"], TERMINAL);
    const back = await bob.cli(["init", "--join", invite.url]);
    expect(back.code).toBe(0);
    expect(back.out).toContain('("bob" was already taken on this board, so you are "bob-2".)');
    expect((await bob.cli(["inbox"])).code).toBe(0);
  });

  it("shows and hands over the board", async () => {
    const { alice, bob } = await team();
    expect((await bob.cli(["owner"])).out).toBe("alice\n");
    expect((await alice.cli(["owner", "bob"])).err).toContain("Only a person");
    expect((await alice.cli(["owner", "bob"], TERMINAL)).out).toContain("bob owns the board now");
    expect((await alice.cli(["owner", "--json"])).out).toBe('{"owner":"bob"}\n');
  });
});

describe("links", () => {
  it("makes open and one-time invites, lists and stops links", async () => {
    const { alice, bob } = await team();
    const openByBob = await bob.cli(["invite", "--open"], TERMINAL);
    expect(openByBob.err).toContain("only the board's owner can make an invite");
    expect((await alice.cli(["invite", "--open"])).err).toContain("Only a person");

    const once = await alice.cli(["invite", "--once", "--label", "for carol", "--json"]);
    const { url, id } = JSON.parse(once.out) as { url: string; id: string };
    expect(JSON.parse(once.out)).toMatchObject({ max_uses: 1, requires_approval: true });

    const listed = await alice.cli(["links"]);
    expect(listed.out).toContain(id);
    expect(listed.out).toMatch(
      /invite +needs approval +0 of 1 used +until .+ by alice +"for carol"/,
    );
    expect(listed.out).toMatch(/feed +read-only/);
    // Bob sees only his own: the feed link he got when he joined.
    const bobs = (await bob.cli(["links"])).out;
    expect(bobs).toContain('by bob  "feed for bob"');
    expect(bobs).not.toContain(id);

    expect((await alice.cli(["revoke", id])).err).toContain("Only a person");
    expect((await alice.cli(["revoke", id], TERMINAL)).out).toBe(`Stopped ${id}.\n`);
    const late = await (await person("carol")).cli(["init", "--join", url, "--owner", "carol"]);
    expect(late.code).toBe(1);
    expect((await alice.cli(["links"])).out).not.toContain(id);
    expect((await alice.cli(["links", "--all"])).out).toMatch(new RegExp(`${id}.*stopped`));
  });

  it("keeps the security log for the owner", async () => {
    const { alice, bob, boardInvite } = await team();
    await carolAsks(boardInvite);
    await alice.cli(["accept", "carol"], TERMINAL);
    const log = await alice.cli(["audit"]);
    expect(log.out).toMatch(/alice +let carol in/);
    expect(log.out).toMatch(/carol +asked to join/);
    expect(log.out).toMatch(/bob +joined/);
    expect((await bob.cli(["audit"])).err).toContain("only the board's owner can read");
  });
});
