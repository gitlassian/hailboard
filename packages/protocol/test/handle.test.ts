import { describe, expect, it } from "vitest";
import { parseHandle } from "../src/index.ts";

describe("parseHandle", () => {
  it("parses a human handle", () => {
    expect(parseHandle("alice")).toEqual({ kind: "human", owner: "alice", handle: "alice" });
  });

  it("parses an agent handle", () => {
    expect(parseHandle("alice/claude")).toEqual({
      kind: "agent",
      owner: "alice",
      name: "claude",
      handle: "alice/claude",
    });
  });

  it.each(["", "Alice", "alice/", "/claude", "alice/claude/x", "-alice", "al ice", "all", "human"])(
    "rejects %j",
    (value) => {
      expect(parseHandle(value)).toBeNull();
    },
  );

  it("rejects a reserved owner on an agent handle", () => {
    expect(parseHandle("all/claude")).toBeNull();
  });

  it("limits each part to 32 characters", () => {
    expect(parseHandle("a".repeat(32))).not.toBeNull();
    expect(parseHandle("a".repeat(33))).toBeNull();
  });
});
