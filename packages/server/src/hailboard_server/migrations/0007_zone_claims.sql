-- 0007_zone_claims: ownership zones become named claims over several paths.
--
-- The table from 0002 was never used by a release (the API did not exist), so it is replaced
-- instead of altered. A zone is what an agent calls "my part of the project": a name, the paths
-- it covers (directories, files or globs) and an optional note. Overlap checks between zones are
-- done by the application. Releasing a zone deletes the row.

drop table zones;

create table zones (
  id          text primary key default aw_id('zon'),
  board_id    text not null,
  member_id   text not null,
  name        text not null check (char_length(name) between 1 and 80),
  note        text check (note is null or char_length(note) <= 300),
  paths       text[] not null check (cardinality(paths) between 1 and 20),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- One name per member: claiming it again replaces the paths.
  constraint zones_member_name_key unique (board_id, member_id, name),
  foreign key (board_id, member_id) references members (board_id, id) on delete cascade
);

create index zones_board_idx on zones (board_id);
