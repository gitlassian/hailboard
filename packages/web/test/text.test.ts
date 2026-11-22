import { describe, expect, it } from "vitest";
import { route, tabFromHash } from "../src/route.ts";
import {
  ago,
  between,
  dayLabel,
  kept,
  short,
  size,
  splitBody,
  splitMentions,
} from "../src/text.ts";

describe("splitMentions", () => {
  it("separates mentions from text", () => {
    expect(splitMentions("@bob/codex ready, cc @Alice and @all")).toEqual([
      { mention: "bob/codex", text: "@bob/codex" },
      { text: " ready, cc " },
      { mention: "alice", text: "@Alice" },
      { text: " and " },
      { mention: "all", text: "@all" },
    ]);
  });

  it("leaves e-mail addresses and package scopes alone, like the server", () => {
    expect(splitMentions("mail a@b.com, install pkg/@scope or x-@y")).toEqual([
      { text: "mail a@b.com, install pkg/@scope or x-@y" },
    ]);
  });

  it("handles empty text", () => {
    expect(splitMentions("")).toEqual([]);
  });
});

describe("ago", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");
  it("describes how long ago", () => {
    expect(ago(null, now)).toBeNull();
    expect(ago("2026-11-06T11:59:30Z", now)).toBe("just now");
    expect(ago("2026-11-06T11:55:00Z", now)).toBe("5 min ago");
    expect(ago("2026-11-06T09:00:00Z", now)).toBe("3 h ago");
    expect(ago("2026-11-04T12:00:00Z", now)).toBe("2 d ago");
    expect(ago("2026-11-06T12:00:05Z", now)).toBe("just now");
  });
});

describe("route", () => {
  const at = (pathname: string) => route({ pathname, origin: "https://ab.example" });

  it("recognises feed and invite links", () => {
    expect(at("/feed/rd_abcdefgh12")).toEqual({ page: "feed", token: "rd_abcdefgh12" });
    expect(at("/join/inv_abcdefgh12/")).toEqual({
      page: "join",
      token: "inv_abcdefgh12",
      url: "https://ab.example/join/inv_abcdefgh12",
    });
  });

  it("rejects anything else", () => {
    expect(at("/")).toEqual({ page: "unknown" });
    expect(at("/feed/")).toEqual({ page: "unknown" });
    expect(at("/feed/short")).toEqual({ page: "unknown" });
    expect(at("/feed/a/b")).toEqual({ page: "unknown" });
    expect(at("/feed/%3Cscript%3E123")).toEqual({ page: "unknown" });
  });
});

describe("splitBody", () => {
  it("separates inline code, and keeps mentions inside code as code", () => {
    expect(splitBody("@bob see `api/orders.md` and `@x` now")).toEqual([
      { mention: "bob", text: "@bob" },
      { text: " see " },
      { code: "api/orders.md" },
      { text: " and " },
      { code: "@x" },
      { text: " now" },
    ]);
  });

  it("leaves a lone backtick and code across lines as text", () => {
    expect(splitBody("it's a ` mark")).toEqual([{ text: "it's a ` mark" }]);
    expect(splitBody("`a\nb`")).toEqual([{ text: "`a\nb`" }]);
  });
});

describe("short and dayLabel", () => {
  const now = Date.parse("2026-11-13T15:00:00Z");
  it("prints a short age", () => {
    expect(short(null, now)).toBe("");
    expect(short("2026-11-13T14:59:30Z", now)).toBe("now");
    expect(short("2026-11-13T14:55:00Z", now)).toBe("5m");
    expect(short("2026-11-13T12:00:00Z", now)).toBe("3h");
    expect(short("2026-11-11T15:00:00Z", now)).toBe("2d");
  });

  it("names today and yesterday", () => {
    expect(dayLabel(new Date(now).toISOString(), now)).toBe("Today");
    expect(dayLabel(new Date(now - 86_400_000).toISOString(), now)).toBe("Yesterday");
  });
});

describe("tabFromHash", () => {
  it("opens the view named in the address, the board otherwise", () => {
    expect(tabFromHash("#context")).toBe("context");
    expect(tabFromHash("#board")).toBe("board");
    expect(tabFromHash("")).toBe("board");
    expect(tabFromHash("#nope")).toBe("board");
  });
});

describe("between", () => {
  it("says how long from one moment to another", () => {
    const at = Date.parse("2026-11-13T15:00:00Z");
    expect(between("2026-11-13T14:59:40Z", at)).toBe("<1m");
    expect(between("2026-11-13T14:56:00Z", at)).toBe("4m");
    expect(between("2026-11-13T13:00:00Z", "2026-11-13T15:00:00Z")).toBe("2h");
    // An answer stamped before its question (clocks) is not a negative time.
    expect(between(at, "2026-11-13T14:00:00Z")).toBe("<1m");
  });
});

describe("size and kept", () => {
  it("writes sizes as people read them", () => {
    expect([size(800), size(2048), size(20_000), size(1_500_000)]).toEqual([
      "800 B",
      "2.0 KB",
      "20 KB",
      "1.4 MB",
    ]);
  });

  it("says how long a file is still kept, and nothing once it is gone", () => {
    const now = Date.parse("2026-11-14T10:00:00Z");
    const left = (expires_at: string, available = true) => kept({ available, expires_at }, now);
    expect(left("2026-11-21T09:59:00Z")).toBe("7 days left");
    expect(left("2026-11-16T22:00:00Z")).toBe("3 days left");
    expect(left("2026-11-15T15:00:00Z")).toBe("29 h left");
    expect(left("2026-11-14T10:20:00Z")).toBe("under 1 h left");
    // The time is up by the reader's clock, or the sender took the file back.
    expect(left("2026-11-14T09:00:00Z")).toBeNull();
    expect(left("2026-11-21T09:59:00Z", false)).toBeNull();
  });
});
