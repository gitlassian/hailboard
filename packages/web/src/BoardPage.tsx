import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import {
  type Board,
  FeedError,
  fetchBoard,
  fetchMembers,
  fetchMessages,
  fetchTasks,
  openStream,
  PAGE_SIZE,
} from "./api.ts";
import { BoardPane } from "./BoardPane.tsx";
import { Chat } from "./Chat.tsx";
import { ContextPane } from "./ContextPane.tsx";
import { assignLooks } from "./people.ts";
import { LogoSprite, LooksContext } from "./pictures/Picture.tsx";
import { TAB_TITLES, TABS, type Tab, tabFromHash } from "./route.ts";
import { Segmented } from "./Segmented.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { feedReducer, initialState } from "./state.ts";
import { TasksPane } from "./TasksPane.tsx";

function useTab(): [Tab, (tab: Tab) => void] {
  const [tab, setTab] = useState<Tab>(() => tabFromHash(window.location.hash));
  useEffect(() => {
    const onHash = () => setTab(tabFromHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const choose = useCallback((next: Tab) => {
    history.replaceState(null, "", `#${next}`);
    setTab(next);
  }, []);
  return [tab, choose];
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/** A board seen through a read-only link: agents on the left, a view in the middle, the chat on
 * the right. */
export function BoardPage({ token }: { token: string }) {
  const [state, dispatch] = useReducer(feedReducer, initialState);
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<FeedError | null>(null);
  const [tab, setTab] = useTab();
  const now = useNow(30_000);
  const looks = useMemo(() => assignLooks(state.members), [state.members]);
  // Board events include document changes; the context view reloads when one arrives.
  const activityCount = state.messages.filter((m) => m.kind === "activity").length;

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const [b, members, messages, tasks] = await Promise.all([
          fetchBoard(token),
          fetchMembers(token),
          fetchMessages(token),
          fetchTasks(token),
        ]);
        if (cancelled) return;
        setBoard(b);
        document.title = `${b.name} · hailboard`;
        dispatch({ type: "loaded", messages, members, pageSize: PAGE_SIZE });
        dispatch({ type: "tasks", tasks });
        stop = openStream(token, messages.at(-1)?.seq ?? 0, {
          onMessage: (message) => dispatch({ type: "message", message }),
          onMember: (member) => dispatch({ type: "member", member }),
          onTask: (task) => dispatch({ type: "task", task }),
          onOpen: () => dispatch({ type: "connection", connection: "live" }),
          onDown: () => dispatch({ type: "connection", connection: "reconnecting" }),
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof FeedError ? e : new FeedError(0, String(e)));
      }
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [token]);

  const loadOlder = useCallback(async () => {
    const first = state.messages[0];
    if (!first) return;
    try {
      const older = await fetchMessages(token, first.seq);
      dispatch({ type: "older", messages: older, pageSize: PAGE_SIZE });
    } catch (e) {
      setError(e instanceof FeedError ? e : new FeedError(0, String(e)));
    }
  }, [state.messages, token]);

  if (error) {
    const invalid = error.status === 401 || error.status === 422;
    return (
      <main className="notice">
        <h1>{invalid ? "This board link does not work" : "Could not load the board"}</h1>
        {invalid ? (
          <p>
            It is invalid, expired or was revoked. Ask a teammate for a new one, created with{" "}
            <code>hailboard feed</code>.
          </p>
        ) : (
          <p>{error.message}</p>
        )}
      </main>
    );
  }

  const loaded = board !== null;
  const connection = loaded ? state.connection : "connecting";

  // A server without tasks has no Tasks view: a link to it opens the board instead.
  const hasTasks = !loaded || state.tasks !== null;
  const view: Tab = tab === "tasks" && !hasTasks ? "board" : tab;

  return (
    <LooksContext.Provider value={looks}>
      <LogoSprite />
      <div className="app">
        <Sidebar
          board={board}
          members={state.members}
          messages={state.messages}
          tasks={state.tasks}
          connection={connection}
          now={now}
        />

        <header className="topbar">
          <span />
          <Segmented
            tabs
            label="Views"
            value={view}
            onChange={setTab}
            choices={TABS.filter((t) => t !== "tasks" || hasTasks).map((t) => ({
              value: t,
              label: TAB_TITLES[t],
              count:
                t === "tasks" && state.tasks
                  ? state.tasks.filter((x) => x.state !== "done").length
                  : undefined,
            }))}
          />
          <span className={`conn ${connection}`}>
            {connection === "live"
              ? "Live"
              : connection === "connecting"
                ? "Connecting…"
                : "Reconnecting…"}
          </span>
        </header>

        <main className="view">
          {view === "board" && (
            <BoardPane
              members={state.members}
              messages={state.messages}
              tasks={state.tasks}
              loaded={loaded}
              now={now}
            />
          )}
          {view === "tasks" && (
            <TasksPane
              tasks={state.tasks}
              members={state.members}
              messages={state.messages}
              now={now}
            />
          )}
          {view === "context" && <ContextPane token={token} changes={activityCount} now={now} />}
        </main>

        <Chat
          messages={state.messages}
          members={state.members}
          loaded={loaded}
          reachedStart={state.reachedStart}
          now={now}
          onLoadOlder={loadOlder}
        />
      </div>
    </LooksContext.Provider>
  );
}
