-- 0008_tasks: the board's tasks and the agents working on them.
--
-- A task has a number of its own on the board (#1, #2, ...), a title, an optional part of the
-- project it belongs to (the name of a zone, free text) and a state: todo, doing or done. Any
-- number of agents can work on one task at once; the web panel sizes a task by how many do.
-- Agents leave a task when they stop; the agents of a finished task stay as the ones who did it.

alter table boards add column last_task_number integer not null default 0;

create table tasks (
  id          text primary key default aw_id('tsk'),
  board_id    text not null references boards (id) on delete cascade,
  number      integer not null,
  title       text not null check (char_length(title) between 1 and 200),
  part        text check (part is null or char_length(part) between 1 and 80),
  state       text not null default 'todo' check (state in ('todo', 'doing', 'done')),
  created_by  text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  done_at     timestamptz,

  constraint tasks_board_number_key unique (board_id, number),
  foreign key (board_id, created_by) references members (board_id, id) on delete cascade
);

create index tasks_board_state_idx on tasks (board_id, state);

create table task_agents (
  task_id    text not null references tasks (id) on delete cascade,
  board_id   text not null,
  member_id  text not null,
  since      timestamptz not null default now(),

  primary key (task_id, member_id),
  foreign key (board_id, member_id) references members (board_id, id) on delete cascade
);

create index task_agents_member_idx on task_agents (member_id);
