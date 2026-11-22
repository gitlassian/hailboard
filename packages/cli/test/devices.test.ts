import { describe, expect, it } from "vitest";
import { person, team } from "./helpers.ts";

/** In a terminal of their own: what `requirePerson` asks for. */
const TERMINAL = { answers: [] as string[] };

function linkIn(out: string): string {
  const match = out.match(/hailboard init --device (\S+)/);
  if (!match?.[1]) throw new Error(`no device link in: ${out}`);
  return match[1];
}

describe("one person on several machines", () => {
  it("brings a second machine on as the same person, without the owner", async () => {
    const { alice, bob } = await team();
    const byAgent = await alice.cli(["device", "add"]);
    expect(byAgent.code).toBe(1);
    expect(byAgent.err).toContain("Only a person can do this");

    const made = await alice.cli(["device", "add", "--name", "desktop"], TERMINAL);
    expect(made.code).toBe(0);
    expect(made.out).toContain("works once, in the next 10 minutes");

    const laptop = await person("alice");
    const joined = await laptop.cli(
      ["init", "--device", linkIn(made.out), "--machine", "laptop"],
      TERMINAL,
    );
    expect(joined.code).toBe(0);
    expect(joined.out).toContain('This machine ("laptop") is on board');
    expect(joined.out).toContain("as alice, with keys of its own");

    // The laptop's agent is alice/claude, and the board still has one alice.
    const posted = await laptop.cli(["post", "--as", "agent", "from the laptop"]);
    expect(posted.code).toBe(0);
    const seen = await bob.cli(["log", "--json"]);
    expect(seen.out).toContain("alice/claude");
    const members = await bob.cli(["members", "--json"]);
    const handles = (JSON.parse(members.out).members as { handle: string }[]).map((m) => m.handle);
    expect(handles.filter((h) => h.startsWith("alice"))).toEqual(["alice", "alice/claude"]);

    const listed = await laptop.cli(["device", "list"], TERMINAL);
    expect(listed.out).toMatch(/desktop +used/);
    expect(listed.out).toMatch(/laptop .*\(this one\)/);
  });

  it("takes one machine off and keeps the other", async () => {
    const { alice } = await team();
    const made = await alice.cli(["device", "add", "--name", "desktop"], TERMINAL);
    const laptop = await person("alice");
    await laptop.cli(["init", "--device", linkIn(made.out), "--machine", "laptop"], TERMINAL);

    const removed = await alice.cli(["device", "remove", "laptop"], TERMINAL);
    expect(removed.code).toBe(0);
    const stopped = await laptop.cli(["inbox"]);
    expect(stopped.code).toBe(1);
    expect(stopped.err).toContain("this machine was taken off the board");
    expect((await alice.cli(["inbox"])).code).toBe(0);
  });

  it("refuses a used link", async () => {
    const { alice } = await team();
    const link = linkIn((await alice.cli(["device", "add"], TERMINAL)).out);
    const first = await person("alice");
    expect((await first.cli(["init", "--device", link, "--machine", "one"], TERMINAL)).code).toBe(
      0,
    );
    const second = await person("alice");
    const again = await second.cli(["init", "--device", link, "--machine", "two"], TERMINAL);
    expect(again.code).toBe(1);
    expect(again.err).toContain("This device link does not work");
  });

  it("looks before it uses a link, and never makes a second person of a removed machine", async () => {
    const { alice, boardInvite } = await team();
    const made = await alice.cli(["device", "add", "--name", "desktop"], TERMINAL);
    const link = linkIn(made.out);
    // The machine that made it is on the board already: the link stays unused.
    const here = await alice.cli(["init", "--device", link], TERMINAL);
    expect(here.code).toBe(1);
    expect(here.err).toContain("already on board");
    const laptop = await person("alice");
    expect(
      (await laptop.cli(["init", "--device", link, "--machine", "laptop"], TERMINAL)).code,
    ).toBe(0);

    expect((await alice.cli(["device", "remove", "laptop"], TERMINAL)).code).toBe(0);
    const rejoin = await laptop.cli(["init", "--join", boardInvite], TERMINAL);
    expect(rejoin.code).toBe(1);
    expect(rejoin.err).toContain("This machine was taken off the board; you are still on it.");
    expect(rejoin.err).toContain("hailboard device add");
  });
});
