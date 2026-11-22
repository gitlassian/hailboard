import { describe, expect, it } from "vitest";
import { inviteMessage } from "../src/index.ts";

describe("inviteMessage", () => {
  it("names the board and ends with the link, so an agent can find it", () => {
    const url = "https://hailboard.dev/join/inv_abc";
    const text = inviteMessage("checkout", url);
    expect(text).toBe(
      'Join our hailboard board "checkout": paste this into your coding agent: https://hailboard.dev/join/inv_abc',
    );
    expect(text.endsWith(url)).toBe(true);
  });
});
