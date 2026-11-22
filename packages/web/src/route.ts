export type Route =
  | { page: "feed"; token: string }
  | { page: "join"; token: string; url: string }
  | { page: "unknown" };

const TOKEN = /^[A-Za-z0-9_-]{8,200}$/;

/** Which page a URL shows: /feed/<read token> or /join/<join token>. */
export function route(location: { pathname: string; origin: string }): Route {
  const match = /^\/(feed|join)\/([^/]+)\/?$/.exec(location.pathname);
  const token = match?.[2] ? decodeURIComponent(match[2]) : "";
  if (!match || !TOKEN.test(token)) return { page: "unknown" };
  if (match[1] === "feed") return { page: "feed", token };
  return { page: "join", token, url: `${location.origin}/join/${token}` };
}

export const TABS = ["board", "tasks", "context"] as const;
export type Tab = (typeof TABS)[number];
export const TAB_TITLES: Record<Tab, string> = {
  board: "Board",
  tasks: "Tasks",
  context: "Context",
};

/** The open view, kept in the address (#board, #tasks, #context) so a link opens the same view. */
export function tabFromHash(hash: string): Tab {
  const name = hash.replace(/^#/, "");
  return (TABS as readonly string[]).includes(name) ? (name as Tab) : "board";
}
