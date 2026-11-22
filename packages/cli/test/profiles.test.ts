import type { MemberOut } from "@hailboard/protocol";
import { describe, expect, it } from "vitest";
import { formatProfile, localTime } from "../src/commands/profile.ts";
import { person, team } from "./helpers.ts";

/** In a terminal of their own: what `requirePerson` asks for. */
const TERMINAL = { answers: [] as string[] };

function member(handle: string, extra: Partial<MemberOut> = {}): MemberOut {
  return {
    handle,
    kind: handle.includes("/") ? "agent" : "human",
    status_text: null,
    last_seen_at: null,
    last_active_at: null,
    read_up_to: 0,
    joined_at: "2026-11-20T10:00:00Z",
    online: false,
    ...extra,
  };
}

describe("profiles", () => {
  it("sets a profile on every board of the machine and shows the card to others", async () => {
    const { alice, bob } = await team();
    const byAgent = await alice.cli(["profile", "set", "--title", "frontend"]);
    expect(byAgent.code).toBe(1);
    expect(byAgent.err).toContain("Only a person can do this");

    const set = await alice.cli(
      ["profile", "set", "--name", "Alice Smith", "--title", "frontend", "--tz", "Europe/Kyiv"],
      TERMINAL,
    );
    expect(set.code).toBe(0);
    expect(set.out).toContain("Profile updated on 1 board.");

    await alice.cli(["status", "--as", "agent", "fixing the checkout tests"]);
    const card = await bob.cli(["profile", "alice"]);
    expect(card.code).toBe(0);
    expect(card.out).toMatch(/^Alice Smith \(alice\) {2}frontend {2}owner\n/);
    expect(card.out).toMatch(/Europe\/Kyiv, \d{2}:\d{2} there/);
    expect(card.out).toMatch(/alice\/claude +fixing the checkout tests/);
    // One machine: no machine names.
    expect(card.out).not.toContain(" on ");

    const json = JSON.parse((await bob.cli(["profile", "alice", "--json"])).out);
    expect(json.person.title).toBe("frontend");
    expect(json.agents.map((a: MemberOut) => a.handle)).toEqual(["alice/claude"]);

    // An empty value clears a field; a wrong time zone is refused.
    await alice.cli(["profile", "set", "--title", ""], TERMINAL);
    const cleared = JSON.parse((await bob.cli(["profile", "alice", "--json"])).out);
    expect(cleared.person.title).toBeNull();
    const wrong = await alice.cli(["profile", "set", "--tz", "Mars/Olympus"], TERMINAL);
    expect(wrong.code).not.toBe(0);
  });

  it("an agent's own card is its person's, and nobody else's card is made up", async () => {
    const { alice } = await team();
    const own = await alice.cli(["profile"]);
    expect(own.code).toBe(0);
    expect(own.out.split("\n")[0]).toContain("alice");
    expect((await alice.cli(["profile", "nobody"])).code).toBe(2);
    // Joining gave alice this machine's time zone.
    const json = JSON.parse((await alice.cli(["profile", "--json"])).out);
    expect(json.person.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);

    const fresh = await person("carol");
    expect((await fresh.cli(["profile", "set", "--name", "Carol"], TERMINAL)).code).toBe(2);
  });

  it("formats machines only when the person has several", () => {
    const now = new Date("2026-11-21T12:00:00Z");
    const alice = member("alice", { display_name: "Alice", timezone: "Europe/Kyiv" });
    const one = formatProfile(alice, [member("alice/claude", { machines: ["laptop"] })], now);
    expect(one).not.toContain("on laptop");
    expect(one).toContain("Europe/Kyiv, 14:00 there");

    const several = formatProfile(
      { ...alice, machines: ["laptop", "desktop"] },
      [
        member("alice/claude", { machines: ["laptop"], status_text: "tests", online: true }),
        member("alice/opus", { machines: ["desktop"] }),
      ],
      now,
    );
    expect(several).toContain("● alice/claude  tests        on laptop");
    expect(several).toContain("○ alice/opus    (no status)  on desktop");
    expect(localTime("Not/AZone", now)).toBeUndefined();
  });
});
