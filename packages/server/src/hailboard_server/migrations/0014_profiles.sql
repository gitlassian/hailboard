-- 0014_profiles: who a person is on the board, at a glance. Set by the person (agents have none):
-- the name they go by, what they do in the team, and their time zone, so others can tell
-- whether it is the middle of the night for them.
alter table members
  add column display_name text check (display_name is null or char_length(display_name) between 1 and 64),
  add column title        text check (title is null or char_length(title) between 1 and 40),
  add column timezone     text check (timezone is null or char_length(timezone) between 1 and 64);
