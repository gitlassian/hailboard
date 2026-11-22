import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { team } from "./helpers.ts";

describe("hailboard claim, zones and release", () => {
  it("takes a part, lists it for the team and gives it back", async () => {
    const { alice, bob } = await team();
    const taken = await alice.cli(
      ["claim", "web/checkout", "web/api.ts", "--name", "Checkout", "--note", "the form"],
      {},
    );
    expect(taken.code).toBe(0);
    expect(taken.out).toContain('You hold "Checkout": web/checkout, web/api.ts.');

    const seen = await bob.cli(["zones"]);
    expect(seen.out).toMatch(
      /^Checkout\s+alice\s+web\/checkout, web\/api\.ts\s+today \d\d:\d\d\s+\(the form\)$/m,
    );
    expect((await bob.cli(["zones", "--mine"])).out).toContain("You hold no part");
    const json = JSON.parse((await alice.cli(["zones", "--json"])).out);
    expect(json.zones).toMatchObject([{ name: "Checkout", owner: "alice", stale: false }]);

    const released = await alice.cli(["release"]);
    expect(released.out).toBe('Released "Checkout".\n');
    expect((await bob.cli(["zones"])).out).toContain("No one has taken a part");
    expect((await alice.cli(["log", "-n", "3"])).out).toContain("· alice released Checkout.");
  });

  it("reads paths from the folder you stand in", async () => {
    const { alice } = await team();
    await mkdir(join(alice.cwd, "web", "cart"), { recursive: true });
    const inside = await alice.cli(["claim", "cart", "--name", "Cart"], {
      cwd: join(alice.cwd, "web"),
    });
    expect(inside.out).toContain('"Cart": web/cart.');
    const up = await alice.cli(["claim", "../api"], { cwd: join(alice.cwd, "web") });
    expect(up.out).toContain('"api": api.');
    expect((await alice.cli(["zones", "--mine"])).out).toMatch(/Cart .* web\/cart/);
  });

  it("refuses paths that are not a part of the repository", async () => {
    const { alice } = await team();
    const whole = await alice.cli(["claim", "."]);
    expect(whole.code).toBe(2);
    expect(whole.err).toContain("whole repository");
    const outside = await alice.cli(["claim", "../elsewhere"]);
    expect(outside.code).toBe(2);
    expect(outside.err).toContain("outside the repository");
    expect((await alice.cli(["claim"])).code).toBe(2);
  });

  it("warns both sides when two parts meet", async () => {
    const { alice, bob } = await team();
    await bob.cli(["claim", "web/checkout", "--name", "Checkout", "--as", "agent"]);
    const mine = await alice.cli(["claim", "web/checkout/form", "--name", "Form", "--as", "agent"]);
    expect(mine.out).toContain('Heads up: this meets bob/codex\'s "Checkout" (web/checkout/form).');
    // The owner learns about it through their inbox.
    const inbox = await bob.cli(["inbox", "--as", "agent"]);
    expect(inbox.out).toContain('heads-up: my claim "Form"');
  });

  it("releases by name and explains what is wrong when it cannot decide", async () => {
    const { alice } = await team();
    expect((await alice.cli(["release"])).err).toContain("You hold no part");
    await alice.cli(["claim", "a", "--name", "A"]);
    await alice.cli(["claim", "b", "--name", "B"]);
    const unclear = await alice.cli(["release"]);
    expect(unclear.code).toBe(2);
    expect(unclear.err).toContain('You hold 2 parts: "A", "B"');
    const wrong = await alice.cli(["release", "C"]);
    expect(wrong.err).toContain('no part named "C"');
    expect((await alice.cli(["release", "A"])).out).toBe('Released "A".\n');
    expect((await alice.cli(["release", "--all"])).out).toBe('Released "B".\n');
  });
});
