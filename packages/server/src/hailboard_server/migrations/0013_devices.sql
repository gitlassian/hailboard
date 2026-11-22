-- 0013_devices: One person on several machines. A person on the board makes a one-time code on a
-- machine that is already on it; another machine redeems the code and gets keys of its own for the
-- same person and their agents, so it does not join as a second person.

-- Which machine a key lives on. Keys made before this, and keys of the machine that joined, have
-- none: that machine is the person's first one.
alter table api_keys
  add column device text check (device is null or char_length(device) between 1 and 64);

create table device_codes (
  id          text primary key default aw_id('dev'),
  board_id    text not null references boards (id) on delete cascade,
  member_id   text not null references members (id) on delete cascade,
  -- The key that made the code: once it is stopped (its machine taken off), the code is too.
  key_id      text not null references api_keys (id) on delete cascade,
  code_hash   bytea not null unique check (octet_length(code_hash) = 32),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  used_by     text                  -- the name of the machine that redeemed it
);

create index device_codes_member_idx on device_codes (member_id);
