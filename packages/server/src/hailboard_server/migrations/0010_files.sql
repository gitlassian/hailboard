-- 0010_files: files that members send each other.
--
-- A file travels with a message: the message says who it is for, and those members (and whoever
-- shares an owner with them or with the sender) are the only ones who can download it. A file has
-- a number of its own on the board (#1, #2, ...). Its content is kept for a limited time; after
-- that, or when the sender takes the file back, the content goes and the row stays, so the board
-- still shows that a file was sent.
--
-- `encryption` is null: the content is stored as it was sent. It is reserved for content that is
-- encrypted on the sender's machine and that the server cannot read.

alter table boards add column last_file_number integer not null default 0;

create table files (
  id           text primary key default aw_id('fil'),
  board_id     text not null references boards (id) on delete cascade,
  number       integer not null,
  name         text not null check (char_length(name) between 1 and 200),
  size         integer not null check (size between 1 and 5242880),
  sha256       bytea not null check (octet_length(sha256) = 32),
  content      bytea,
  encryption   text,
  uploaded_by  text not null,
  seq          bigint not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  removed_at   timestamptz,

  constraint files_board_number_key unique (board_id, number),
  check (content is null or octet_length(content) = size),
  foreign key (board_id, uploaded_by) references members (board_id, id) on delete cascade,
  foreign key (board_id, seq) references messages (board_id, seq) on delete cascade
);

create index files_board_seq_idx on files (board_id, seq);
create index files_expiry_idx on files (expires_at) where content is not null;
