import { describe, expect, it } from "vitest";
import {
  applyInstall,
  applyUninstall,
  HOOK_EVENTS,
  installedEvents,
  isManaged,
  MARKER,
  type Settings,
  WAKE_TIMEOUT_SECONDS,
  wakeInstalled,
} from "../src/adapters/claude-code/settings.ts";

const options = { command: "hailboard", events: HOOK_EVENTS, file: "settings.json" };
const install = (settings: Settings, overrides = {}) =>
  applyInstall(settings, { ...options, ...overrides });

const userHook = { type: "command", command: "./scripts/lint.sh", timeout: 10 };
const existing: Settings = {
  model: "opus",
  permissions: { allow: ["Bash(git status)"] },
  hooks: {
    PostToolUse: [{ matcher: "Edit|Write", hooks: [userHook] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }],
  },
};

describe("applyInstall", () => {
  it("adds a hook for every event to empty settings", () => {
    const { settings, changedEvents } = install({});
    expect(changedEvents).toEqual([...HOOK_EVENTS]);
    expect(installedEvents(settings)).toEqual([...HOOK_EVENTS]);

    const hooks = settings.hooks as Record<
      string,
      Array<{ hooks: Array<{ command: string; timeout: number }> }>
    >;
    expect(hooks.UserPromptSubmit?.[0]?.hooks[0]).toEqual({
      type: "command",
      command: `hailboard hook prompt ${MARKER}`,
      timeout: 5,
    });
    expect(hooks.SessionStart?.[0]?.hooks[0]?.command).toBe(
      `hailboard hook session-start ${MARKER}`,
    );
  });

  it("leaves everything that was there untouched and in the same order", () => {
    const { settings } = install(existing);
    expect(settings.model).toBe("opus");
    expect(settings.permissions).toEqual(existing.permissions);

    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toEqual((existing.hooks as Record<string, unknown[]>).PreToolUse);
    // The user's own PostToolUse group is first and unchanged; ours is added after it.
    expect(hooks.PostToolUse).toHaveLength(2);
    expect(hooks.PostToolUse?.[0]).toEqual({ matcher: "Edit|Write", hooks: [userHook] });
  });

  it("does not modify its input", () => {
    const copy = structuredClone(existing);
    install(existing);
    expect(existing).toEqual(copy);
  });

  it("is idempotent", () => {
    const once = install(existing).settings;
    const twice = install(once);
    expect(twice.changedEvents).toEqual([]);
    expect(twice.settings).toEqual(once);
  });

  it("updates its own entry in place when the command changes", () => {
    const first = install(existing).settings;
    const { settings, changedEvents } = install(first, { command: "node /opt/ab.js" });
    expect(changedEvents).toEqual([...HOOK_EVENTS]);
    const groups = (settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)
      .PostToolUse;
    expect(groups).toHaveLength(2);
    expect(groups?.[1]?.hooks[0]?.command).toBe(`node /opt/ab.js hook tool ${MARKER}`);
  });

  it("removes duplicates of its own entry", () => {
    const one = install({}).settings;
    const hooks = one.hooks as Record<string, unknown[]>;
    hooks.Stop = [...(hooks.Stop ?? []), ...(hooks.Stop ?? [])];
    const { settings } = install(one);
    expect((settings.hooks as Record<string, unknown[]>).Stop).toHaveLength(1);
  });

  it("can install only some events", () => {
    const { settings } = install({}, { events: ["SessionStart", "UserPromptSubmit"], wake: false });
    expect(installedEvents(settings)).toEqual(["SessionStart", "UserPromptSubmit"]);
    expect(wakeInstalled(settings)).toBe(false);
  });

  it("adds the background wake hook next to the Stop hook", () => {
    const { settings } = install({});
    expect(wakeInstalled(settings)).toBe(true);
    const stop = (settings.hooks as Record<string, Array<{ hooks: unknown[] }>>).Stop;
    expect(stop).toHaveLength(1);
    expect(stop?.[0]?.hooks).toEqual([
      { type: "command", command: `hailboard hook stop ${MARKER}`, timeout: 5 },
      {
        type: "command",
        command: `hailboard hook wake ${MARKER}`,
        asyncRewake: true,
        timeout: WAKE_TIMEOUT_SECONDS,
      },
    ]);
  });

  it("keeps the wake hook without the Stop hook, and can leave it out", () => {
    const noStop = install({}, { events: HOOK_EVENTS.filter((e) => e !== "Stop") }).settings;
    const stop = (noStop.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)
      .Stop;
    expect(stop?.[0]?.hooks.map((h) => h.command)).toEqual([`hailboard hook wake ${MARKER}`]);

    const noWake = install({}, { wake: false }).settings;
    expect(wakeInstalled(noWake)).toBe(false);
    expect(installedEvents(noWake)).toEqual([...HOOK_EVENTS]);
  });

  it("removes the wake hook when reinstalled without it", () => {
    const withWake = install({}).settings;
    const { settings, changedEvents } = install(withWake, { wake: false });
    expect(changedEvents).toEqual(["Stop"]);
    expect(wakeInstalled(settings)).toBe(false);
  });

  it("refuses settings it does not understand instead of overwriting them", () => {
    expect(() => install({ hooks: "nope" })).toThrow(/not an object/);
    expect(() => install({ hooks: { Stop: "nope" } })).toThrow(/not a list/);
  });

  it("keeps groups it does not understand", () => {
    const odd: Settings = { hooks: { Stop: ["weird", { matcher: "x" }] } };
    const { settings } = install(odd);
    expect((settings.hooks as Record<string, unknown[]>).Stop?.slice(0, 2)).toEqual([
      "weird",
      { matcher: "x" },
    ]);
  });
});

describe("applyUninstall", () => {
  it("removes only its own hooks and restores the original settings", () => {
    const installed = install(existing).settings;
    const { settings, removed } = applyUninstall(installed, "settings.json");
    expect(removed).toBe(HOOK_EVENTS.length + 1); // one per event, plus the wake hook
    expect(settings).toEqual(existing);
  });

  it("removes nothing when there is nothing to remove", () => {
    const { settings, removed } = applyUninstall(existing, "settings.json");
    expect(removed).toBe(0);
    expect(settings).toEqual(existing);
  });

  it("keeps the user's handler when it shares a group with ours", () => {
    const shared: Settings = {
      hooks: {
        Stop: [
          { hooks: [userHook, { type: "command", command: `hailboard hook stop ${MARKER}` }] },
        ],
      },
    };
    const { settings, removed } = applyUninstall(shared, "settings.json");
    expect(removed).toBe(1);
    expect(settings.hooks).toEqual({ Stop: [{ hooks: [userHook] }] });
  });

  it("leaves an empty object when only our hooks were there", () => {
    expect(applyUninstall(install({}).settings, "settings.json").settings).toEqual({});
  });
});

describe("isManaged", () => {
  it("recognises only commands carrying the marker", () => {
    expect(isManaged({ type: "command", command: `x hook prompt ${MARKER}` })).toBe(true);
    expect(isManaged({ type: "command", command: "hailboard hook prompt" })).toBe(false);
    expect(isManaged("hailboard")).toBe(false);
    expect(isManaged(null)).toBe(false);
  });
});
