-- 0002_zones: ownership zones (paths an agent has claimed).
--
-- Not used by the first release of the server; the table exists so the schema is complete.
-- Overlap checks between globs are done by the application. Releasing a zone deletes the row.

create table zones (
  id          text primary key default aw_id('zon'),
  board_id    text not null,
  member_id   text not null,
  path_glob   text not null check (char_length(path_glob) between 1 and 300),
  created_at  timestamptz not null default now(),

  constraint zones_member_glob_key unique (board_id, member_id, path_glob),
  foreign key (board_id, member_id) references members (board_id, id) on delete cascade
);

create index zones_board_idx on zones (board_id);
