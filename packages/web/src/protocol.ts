// What the page reads from the server. The page has to work with a server that does not have
// every feature yet (it is also pointed at other servers, see the README), so what came later is
// described here as something a server may or may not send, instead of being taken from the
// protocol package of one version.
import type { MemberOut as ServerMember } from "@hailboard/protocol";

export type {
  BoardCreated,
  Document,
  DocumentInfo,
  FileRef,
  InviteInfo,
  Message,
  MessagesPage,
} from "@hailboard/protocol";

/**
 * A member. `last_active_at` is the last request that was not a wait for messages; only a server
 * that tells an agent at work from one that listens sends it.
 */
export type MemberOut = ServerMember & { last_active_at?: string | null };

export type TaskState = "todo" | "doing" | "done";

/** A task, from a server that has tasks (`GET /v1/feed/tasks`, `task` events in the stream). */
export interface Task {
  number: number;
  title: string;
  /** The part of the project it belongs to. */
  part: string | null;
  state: TaskState;
  /** Who works on it now, or who did it, in the order they took it. */
  agents: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
  done_at: string | null;
}
