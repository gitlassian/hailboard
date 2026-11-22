-- 0004_member_joins: remember who issued an invite, so the event posted when someone joins can
-- say through whose invite they came. Null for the invite created together with the board and
-- for tokens issued before this migration.

alter table board_tokens
  add column created_by text references members (id) on delete set null;
