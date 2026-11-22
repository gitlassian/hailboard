-- 0006_documents: shared documents of a board (plans, schemas, API contracts, decisions).
--
-- `documents` holds the current version of each document, `document_versions` every version
-- including the current one. Names are path-like ("plan.md", "api/users.md") and unique per board.
-- A pinned document is the board's context: agents receive it when a session starts.

create table documents (
  board_id    text not null references boards (id) on delete cascade,
  name        text not null check (
                char_length(name) between 1 and 120
                and name ~ '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$'
              ),
  body        text not null check (char_length(body) <= 100000),
  version     integer not null check (version >= 1),
  pinned      boolean not null default false,
  updated_by  text not null,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),

  primary key (board_id, name),
  foreign key (board_id, updated_by) references members (board_id, id)
);

create table document_versions (
  board_id    text not null,
  name        text not null,
  version     integer not null,
  body        text not null,
  author_id   text not null,
  created_at  timestamptz not null default now(),

  primary key (board_id, name, version),
  foreign key (board_id, name) references documents (board_id, name) on delete cascade,
  foreign key (board_id, author_id) references members (board_id, id)
);
