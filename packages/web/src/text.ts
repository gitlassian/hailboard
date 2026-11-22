/** Same rule as the server: "@" not after a word character, "@", "/" or "-". */
const MENTION_RE =
  /(?<![\w@/-])@([a-z0-9][a-z0-9-]{0,31}(?:\/[a-z0-9][a-z0-9-]{0,31})?)(?![\w-])/gi;

export type Segment = { text: string } | { mention: string; text: string };

/** Splits a message body into plain text and @mentions, so mentions can be highlighted. */
export function splitMentions(body: string): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const match of body.matchAll(MENTION_RE)) {
    const start = match.index;
    if (start > at) out.push({ text: body.slice(at, start) });
    out.push({ mention: (match[1] ?? "").toLowerCase(), text: match[0] });
    at = start + match[0].length;
  }
  if (at < body.length) out.push({ text: body.slice(at) });
  return out;
}

export type BodySegment = Segment | { code: string };

/** Splits a message body into plain text, @mentions and `inline code`. Mentions inside code stay
 * code. A lone backtick is plain text. */
export function splitBody(body: string): BodySegment[] {
  const out: BodySegment[] = [];
  let at = 0;
  for (const match of body.matchAll(/`([^`\n]+)`/g)) {
    if (match.index > at) out.push(...splitMentions(body.slice(at, match.index)));
    out.push({ code: match[1] ?? "" });
    at = match.index + match[0].length;
  }
  if (at < body.length) out.push(...splitMentions(body.slice(at)));
  return out;
}

/** Short age for lists: "now", "5m", "3h", "2d". */
export function short(iso: string | null, now: number): string {
  if (iso === null) return "";
  const diff = Math.max(0, now - Date.parse(iso));
  if (diff < MINUTE) return "now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  return `${Math.floor(diff / DAY)}d`;
}

/** How long from one moment to another, as "<1m", "4m" or "2h". Both are ISO times or clock values. */
export function between(from: string | number, to: string | number): string {
  const at = (v: string | number) => (typeof v === "number" ? v : Date.parse(v));
  const minutes = Math.max(0, Math.round((at(to) - at(from)) / MINUTE));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

/** "Today", "Yesterday" or the date, for the day lines in the chat. */
export function dayLabel(iso: string, now: number): string {
  const day = new Date(iso).toDateString();
  if (day === new Date(now).toDateString()) return "Today";
  // The calendar day before, also on a day when the clocks change.
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === yesterday.toDateString()) return "Yesterday";
  return new Date(iso).toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

/** "800 B", "12 KB", "1.4 MB". */
export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * How long the server still keeps a file: "7 days left", "3 h left"; null once it is gone (its
 * time is up, or the sender took it back).
 */
export function kept(file: { available: boolean; expires_at: string }, now: number): string | null {
  const ms = Date.parse(file.expires_at) - now;
  if (!file.available || ms <= 0) return null;
  if (ms < HOUR) return "under 1 h left";
  if (ms < 2 * DAY) return `${Math.floor(ms / HOUR)} h left`;
  return `${Math.round(ms / DAY)} days left`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "2 d ago"; null for never. */
export function ago(iso: string | null, now: number): string | null {
  if (iso === null) return null;
  const diff = Math.max(0, now - Date.parse(iso));
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  return `${Math.floor(diff / DAY)} d ago`;
}

/** Time of day for today's messages, otherwise the date and time. */
export function stamp(iso: string, now: number): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (new Date(now).toDateString() === date.toDateString()) return time;
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day}, ${time}`;
}
