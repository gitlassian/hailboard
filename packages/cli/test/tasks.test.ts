import { describe, expect, it } from "vitest";
import { team } from "./helpers.ts";

describe("hailboard task", () => {
  it("adds, takes and finishes tasks and lists who works on each", async () => {
    const { alice, bob } = await team();
    const added = await alice.cli(["task", "add", "Cart", "totals", "--part", "cart"]);
    expect(added.code).toBe(0);
    expect(added.out).toBe("Added #1 Cart totals [cart]\n");

    const taken = await bob.cli(["task", "take", "1", "--as", "agent"]);
    expect(taken.out).toBe("You are on #1 Cart totals [cart] (bob/codex)\n");
    const both = await alice.cli(["task", "take", "#1"]);
    expect(both.out).toContain("(bob/codex, alice)");

    const list = await bob.cli(["task"]);
    expect(list.out).toMatch(/^#1\s+doing\s+Cart totals\s+\[cart\]\s+bob\/codex, alice$/m);
    expect((await bob.cli(["task", "--mine"])).out).toContain("You are on no task");
    const json = JSON.parse((await bob.cli(["task", "--json", "--mine", "--as", "agent"])).out);
    expect(json.tasks).toMatchObject([{ number: 1, state: "doing" }]);

    const done = await bob.cli(["task", "done", "1", "--as", "agent"]);
    expect(done.out).toContain("Done: #1 Cart totals");
    expect((await bob.cli(["task"])).out).toContain("No open tasks");
    expect((await bob.cli(["task", "--all"])).out).toMatch(/#1\s+done/);
    expect((await alice.cli(["log", "-n", "1"])).out).toContain("finished the task #1 Cart totals");
  });

  it("adds and takes in one go, and explains wrong input", async () => {
    const { alice } = await team();
    const both = await alice.cli(["task", "add", "Checkout", "--take", "--as", "agent"]);
    expect(both.out).toBe("Added and took #1 Checkout (alice/claude)\n");
    expect((await alice.cli(["task", "take"])).code).not.toBe(0);
    expect((await alice.cli(["task", "add"])).code).not.toBe(0);
    const missing = await alice.cli(["task", "done", "9"]);
    expect(missing.code).not.toBe(0);
    expect(missing.err).toContain("no task #9");
    expect((await alice.cli(["task", "frobnicate"])).err).toContain(
      'Unknown task action "frobnicate"',
    );
  });
});
