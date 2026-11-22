-- 0012_invites_and_audit: Invites that end: after a time, after a number of uses, and that may need the owner's approval.
-- And a log of what was done to whom on a board, for its owner.

alter table board_tokens
  add column max_uses           integer check (max_uses is null or max_uses between 1 and 1000),
  add column uses               integer not null default 0 check (uses >= 0),
  add column requires_approval  boolean not null default true,
  add column revoked_by         text;

-- Feed links never needed anyone's approval.
update board_tokens set requires_approval = false where scope = 'read';

-- A board's first links were made before anyone was on it: they belong to its owner, and stop
-- with the owner like any link a member made (see membership.take_off).
update board_tokens t set created_by = m.id
  from members m
 where m.board_id = t.board_id and m.role = 'owner' and t.created_by is null;

-- Invites given out so far never ended. They keep working for a week, then end like new ones.
update board_tokens
   set expires_at = now() + interval '7 days'
 where scope = 'join' and expires_at is null and revoked_at is null;

create table security_events (
  id          bigint generated always as identity primary key,
  board_id    text not null references boards (id) on delete cascade,
  actor       text,                 -- handle of who did it; null for the server itself
  kind        text not null check (char_length(kind) between 1 and 40),
  subject     text,                 -- handle or link the event is about
  data        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

create index security_events_board_idx on security_events (board_id, created_at desc);
