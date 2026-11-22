import type {
  BoardCreated,
  Document,
  DocumentInfo,
  InviteInfo,
  MemberOut,
  Message,
  MessagesPage,
  Task,
} from "./protocol.ts";

export type Board = BoardCreated["board"];

export class FeedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) {
    let message = `request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // not JSON: keep the generic message
    }
    throw new FeedError(res.status, message);
  }
  return (await res.json()) as T;
}

const q = encodeURIComponent;

export const PAGE_SIZE = 100;

/** What an invite link leads to. Fails with status 401 for an unknown or expired invite. */
export function fetchInvite(token: string): Promise<InviteInfo> {
  return get(`/v1/invite?token=${q(token)}`);
}

export function fetchBoard(token: string): Promise<Board> {
  return get(`/v1/feed/board?token=${q(token)}`);
}

export async function fetchMembers(token: string): Promise<MemberOut[]> {
  return (await get<{ members: MemberOut[] }>(`/v1/feed/members?token=${q(token)}`)).members;
}

/** The latest messages, or the ones just before message `before`. Oldest first. */
export async function fetchMessages(token: string, before?: number): Promise<Message[]> {
  const page = before === undefined ? "" : `&before=${before}`;
  const res = await get<MessagesPage>(
    `/v1/feed/messages?token=${q(token)}&limit=${PAGE_SIZE}${page}`,
  );
  return res.messages;
}

export async function fetchDocuments(token: string): Promise<DocumentInfo[]> {
  return (await get<{ documents: DocumentInfo[] }>(`/v1/feed/docs?token=${q(token)}`)).documents;
}

/** The board's tasks, or null from a server that has none yet. */
export async function fetchTasks(token: string): Promise<Task[] | null> {
  try {
    return (await get<{ tasks: Task[] }>(`/v1/feed/tasks?token=${q(token)}`)).tasks;
  } catch (e) {
    if (e instanceof FeedError && e.status === 404) return null;
    throw e;
  }
}

export function fetchDocument(token: string, name: string): Promise<Document> {
  const path = name.split("/").map(q).join("/");
  return get(`/v1/feed/docs/${path}?token=${q(token)}`);
}

export interface StreamHandlers {
  onMessage(message: Message): void;
  onMember(member: MemberOut): void;
  onTask(task: Task): void;
  onOpen(): void;
  onDown(): void;
}

const RETRY_MS = 5000;

/**
 * Live updates over Server-Sent Events, starting after message `after`. The browser reconnects
 * by itself after short drops (sending the last message number); when it gives up, for example
 * because the server restarted, a new stream is opened from the latest message seen.
 */
export function openStream(token: string, after: number, on: StreamHandlers): () => void {
  let last = after;
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const connect = () => {
    source = new EventSource(`/v1/stream?token=${q(token)}&last_event_id=${last}`);
    source.onopen = () => on.onOpen();
    source.addEventListener("message", (event) => {
      const message = JSON.parse(event.data) as Message;
      last = Math.max(last, message.seq);
      on.onMessage(message);
    });
    source.addEventListener("member", (event) => on.onMember(JSON.parse(event.data) as MemberOut));
    source.addEventListener("task", (event) => on.onTask(JSON.parse(event.data) as Task));
    source.onerror = () => {
      on.onDown();
      if (source?.readyState === EventSource.CLOSED && !closed) {
        source.close();
        retry = setTimeout(connect, RETRY_MS);
      }
    };
  };

  connect();
  return () => {
    closed = true;
    clearTimeout(retry);
    source?.close();
  };
}
