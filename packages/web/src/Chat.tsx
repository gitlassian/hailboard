import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { daySummary, recentThreads, type Thread } from "./board.ts";
import { Copy } from "./Copy.tsx";
import { Icon } from "./Icon.tsx";
import { jumpTo, onJump, showMessage } from "./jump.ts";
import { Identity, Picture, useColour } from "./pictures/Picture.tsx";
import type { FileRef, MemberOut, Message } from "./protocol.ts";
import { Segmented } from "./Segmented.tsx";
import { asksHuman, expectedAnswerers, receipts, replyCounts, replyPrompt } from "./state.ts";
import { between, dayLabel, kept, size, splitBody, stamp } from "./text.ts";

const NEAR_BOTTOM_PX = 120;
/** How many recipient pictures a receipt shows before "+N". */
const RECEIPT_PICTURES = 4;
/** How many questions the Questions view lists. */
const QUESTIONS_SHOWN = 40;

type Mode = "all" | "questions";

/**
 * The right column: the agents' conversation, read-only, newest at the bottom. "Questions" shows
 * only what agents asked each other and what became of it.
 */
export function Chat({
  messages,
  members,
  loaded,
  reachedStart,
  now,
  onLoadOlder,
}: {
  messages: Message[];
  members: MemberOut[];
  loaded: boolean;
  reachedStart: boolean;
  now: number;
  onLoadOlder: () => Promise<void>;
}) {
  const streamRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const keepOffset = useRef<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [mode, setMode] = useState<Mode>("all");
  // Where the conversation was scrolled to when the reader left it, and a message to show on return.
  const savedTop = useRef<number | null>(null);
  const pending = useRef<number | null>(null);

  const choose = (next: Mode) => {
    if (next === mode) return;
    const el = streamRef.current;
    if (mode === "all" && el) savedTop.current = stickToBottom.current ? null : el.scrollTop;
    setMode(next);
  };

  // Another view asks for a message: back to the conversation if need be, then to the message.
  const modeNow = useRef(mode);
  modeNow.current = mode;
  useEffect(
    () =>
      onJump((seq) => {
        if (modeNow.current === "all") showMessage(seq);
        else {
          pending.current = seq;
          setMode("all");
        }
      }),
    [],
  );

  // Back in the conversation: the place it was left at, or the message that was asked for.
  useLayoutEffect(() => {
    const el = streamRef.current;
    if (mode !== "all" || !el) return;
    el.scrollTop = savedTop.current ?? el.scrollHeight;
    if (pending.current !== null) {
      showMessage(pending.current);
      pending.current = null;
    }
  }, [mode]);

  // Follow new messages while the reader is at the bottom; keep the place when older ones load.
  // biome-ignore lint/correctness/useExhaustiveDependencies: must run after every change to the messages
  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    if (keepOffset.current !== null) {
      el.scrollTop = el.scrollHeight - keepOffset.current;
      keepOffset.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const onScroll = () => {
    const el = streamRef.current;
    if (el)
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  };

  const loadOlder = useCallback(async () => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    const el = streamRef.current;
    if (el) keepOffset.current = el.scrollHeight - el.scrollTop;
    try {
      await onLoadOlder();
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, onLoadOlder]);

  const replies = replyCounts(messages);
  // The same rule as on the board: a question between members is answered by a reply, or by the
  // next message from someone it was addressed to. News that got a reply is not "answered".
  const threads = recentThreads(messages, Number.POSITIVE_INFINITY);
  const answered = new Set(threads.filter((t) => t.answer !== null).map((t) => t.question.seq));
  const open = threads.length - answered.size;
  const bySeq = new Map(messages.map((m) => [m.seq, m]));
  const handles = new Set(members.map((m) => m.handle));

  return (
    <aside className="aside" aria-label="Chat">
      <div className="card-head">
        <span>Chat</span>
        <span className="head-end">
          <Segmented
            label="What the chat shows"
            value={mode}
            onChange={choose}
            choices={[
              { value: "all", label: "All" },
              { value: "questions", label: "Questions", count: open > 0 ? open : undefined },
            ]}
          />
        </span>
      </div>
      {mode === "questions" && (
        <Questions threads={threads.slice(0, QUESTIONS_SHOWN)} messages={messages} now={now} />
      )}
      <div
        className="stream"
        ref={streamRef}
        onScroll={onScroll}
        aria-live="polite"
        hidden={mode !== "all"}
      >
        {loaded && !reachedStart && messages.length > 0 && (
          <button type="button" className="older" onClick={loadOlder} disabled={loadingOlder}>
            {loadingOlder ? "Loading…" : "Load older messages"}
          </button>
        )}
        {!loaded && <p className="stream-note">Loading…</p>}
        {loaded && messages.length === 0 && (
          <div className="stream-note">
            <p>No messages yet.</p>
            <p>
              Agents post here with <code>hailboard post</code> or the MCP <code>post</code> tool.
            </p>
          </div>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const newDay =
            !prev ||
            new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
          return (
            <Fragment key={m.seq}>
              {newDay && <div className="day">{dayLabel(m.created_at, now)}</div>}
              {m.kind === "activity" ? (
                <Event message={m} handles={handles} now={now} />
              ) : (
                <MessageItem
                  message={m}
                  quoted={m.reply_to !== null ? bySeq.get(m.reply_to) : undefined}
                  replies={replies.get(m.seq) ?? 0}
                  answered={answered.has(m.seq)}
                  members={members}
                  now={now}
                  onJump={showMessage}
                />
              )}
            </Fragment>
          );
        })}
      </div>
    </aside>
  );
}

/** What agents asked each other, newest first, and whether somebody answered. */
function Questions({
  threads,
  messages,
  now,
}: {
  threads: Thread[];
  messages: Message[];
  now: number;
}) {
  const day = daySummary(messages, now);
  return (
    <div className="stream questions">
      {threads.length === 0 ? (
        <div className="stream-note">
          <p>No questions between agents yet.</p>
          <p>A message that asks somebody something shows up here, with what became of it.</p>
        </div>
      ) : (
        <>
          <p className="q-day">
            Last 24 hours: <b className="q-day-n">{day.questions}</b>{" "}
            {day.questions === 1 ? "question" : "questions"},{" "}
            <b className="q-day-n">{day.answered}</b> answered
            {day.medianAnswerMinutes !== null && (
              <>
                {" "}
                in about <b className="q-day-n">{day.medianAnswerMinutes || "<1"}</b> min
              </>
            )}
            .
          </p>
          {threads.map((t) => (
            <Question key={t.question.seq} thread={t} now={now} />
          ))}
        </>
      )}
    </div>
  );
}

function Question({ thread, now }: { thread: Thread; now: number }) {
  const { question, answer } = thread;
  const to = question.recipients.filter((r) => r !== question.from);
  return (
    <button
      type="button"
      className="q"
      onClick={() => {
        // The same road as from the board: the chat goes back to the conversation and there.
        jumpTo(answer?.seq ?? question.seq);
      }}
    >
      <span className="q-head">
        <span className="q-who">
          <Picture handle={question.from} small />
          <span className="q-arrow">→</span>
          {to.slice(0, RECEIPT_PICTURES).map((h) => (
            <Picture key={h} handle={h} small />
          ))}
        </span>
        {answer ? (
          <span className="q-state ok">
            answered in {between(question.created_at, answer.created_at)}
          </span>
        ) : (
          <span className="q-state wait">no answer · {between(question.created_at, now)}</span>
        )}
      </span>
      <span className="q-text">
        <span className="mid">#{question.seq}</span> {question.body}
      </span>
    </button>
  );
}

const HANDLE_RE = /\b[a-z0-9][a-z0-9-]{0,31}(?:\/[a-z0-9][a-z0-9-]{0,31})?\b/gi;

/** Board events ("alice joined with the agent alice/claude") on one centred line, handles as
 * pictures with names. */
function Event({ message, handles, now }: { message: Message; handles: Set<string>; now: number }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of message.body.matchAll(HANDLE_RE)) {
    const handle = match[0].toLowerCase();
    if (!handles.has(handle)) continue;
    if (match.index > at) parts.push(message.body.slice(at, match.index));
    parts.push(<Identity key={match.index} handle={handle} small />);
    at = match.index + match[0].length;
  }
  if (at < message.body.length) parts.push(message.body.slice(at).replace(/\.$/, ""));
  return (
    <div className="event" id={`m-${message.seq}`}>
      <span>
        {parts}
        <span className="when">· {stamp(message.created_at, now)}</span>
      </span>
    </div>
  );
}

function Mention({ handle, text }: { handle: string; text: string }) {
  const colour = useColour(handle);
  const special = handle === "human" || handle === "humans" || handle === "all";
  return <span className={special ? "mention" : `mention person ${colour}`}>{text}</span>;
}

function MessageItem({
  message,
  quoted,
  replies,
  answered,
  members,
  now,
  onJump,
}: {
  message: Message;
  quoted: Message | undefined;
  replies: number;
  /** A question between members that somebody has answered. */
  answered: boolean;
  members: MemberOut[];
  now: number;
  onJump: (seq: number) => void;
}) {
  const colour = useColour(message.from);
  const ask = asksHuman(message);
  const open = ask && replies === 0;
  const replyTo = message.reply_to;
  const classes = ["msg"];
  if (open) classes.push("asks");
  return (
    <article id={`m-${message.seq}`} className={classes.join(" ")}>
      <div className="head">
        <Identity handle={message.from} className={`from ${colour}`} />
        <span className="mid">#{message.seq}</span>
        <time
          className="dim"
          dateTime={message.created_at}
          title={new Date(message.created_at).toLocaleString()}
        >
          {stamp(message.created_at, now)}
        </time>
      </div>
      {replyTo !== null && (
        <button type="button" className="reply" onClick={() => onJump(replyTo)}>
          <Icon name="reply" />
          <span>
            #{replyTo}
            {quoted ? ` ${quoted.body}` : ""}
          </span>
        </button>
      )}
      <p className="text">
        {splitBody(message.body).map((s, i) => {
          // biome-ignore-start lint/suspicious/noArrayIndexKey: segments of one immutable message
          if ("code" in s) return <code key={i}>{s.code}</code>;
          if ("mention" in s) return <Mention key={i} handle={s.mention} text={s.text} />;
          return <Fragment key={i}>{s.text}</Fragment>;
          // biome-ignore-end lint/suspicious/noArrayIndexKey: segments of one immutable message
        })}
      </p>
      {(message.files ?? []).map((file) => (
        <Attachment key={file.number} file={file} now={now} />
      ))}
      {open ? (
        <HumanAnswer message={message} />
      ) : (
        <Receipt message={message} members={members} answered={ask || answered} />
      )}
    </article>
  );
}

/**
 * A file the message carries: its name, its size and how long the server still keeps it. The page
 * only shows that it went by: the content is for the members it was sent to.
 */
function Attachment({ file, now }: { file: FileRef; now: number }) {
  const left = kept(file, now);
  return (
    <div
      className={left === null ? "file gone" : "file"}
      title={
        left === null
          ? "The server no longer keeps this file"
          : `Only the members it was sent to, its sender and the people they work for can get it: hailboard file get ${file.number}`
      }
    >
      <span className="file-mark">
        <Icon name="file" />
      </span>
      <span className="file-what">
        <span className="file-name">{file.name}</span>
        <span className="file-meta">
          file {file.number} · {size(file.size)} · {left ?? "no longer kept"}
        </span>
      </span>
    </div>
  );
}

/** Pictures of who the message was for, with one tick (not everyone has it yet) or two (all of
 * them have it). A message reaches someone once it is in their agent's context, or the person read
 * their inbox. */
function Receipt({
  message,
  members,
  answered,
}: {
  message: Message;
  members: MemberOut[];
  answered: boolean;
}) {
  if (message.recipients.length === 0 && !answered) return null;
  const { seen, waiting } = receipts(message, members);
  const all = waiting.length === 0;
  const shown = message.recipients.slice(0, RECEIPT_PICTURES);
  const more = message.recipients.length - shown.length;
  const title = [
    seen.length ? `Read by ${seen.join(", ")}` : "",
    waiting.length ? `Not read by ${waiting.join(", ")} yet` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="rcpt" title={title || undefined}>
      <span className="end">
        {answered && <span className="note">answered</span>}
        {shown.length > 0 && (
          <span className="pics">
            {shown.map((h) => (
              <Picture key={h} handle={h} small />
            ))}
            {more > 0 && <span className="more">+{more}</span>}
          </span>
        )}
        {message.recipients.length > 0 && (
          <Icon name={all ? "checks" : "check"} className={all ? "tick read" : "tick"} />
        )}
      </span>
    </div>
  );
}

/** A question for a person nobody has answered yet, and how to answer it: through your own agent,
 * or from a terminal. */
function HumanAnswer({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const people = expectedAnswerers(message);
  return (
    <div className="needs">
      <div className="rcpt needs-line">
        <span className="dot" />
        needs {people.length ? people.map((p) => `@${p}`).join(", ") : "a person"}
        <button type="button" className="answer-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "How to answer"}
        </button>
      </div>
      {open && (
        <div className="answer">
          <p>Paste this into your agent, then type your answer:</p>
          <Copy text={replyPrompt(message.seq)} wrap />
          <p className="hint">
            Or in a terminal: <code>hailboard post --reply {message.seq} "your answer"</code>
          </p>
        </div>
      )}
    </div>
  );
}
