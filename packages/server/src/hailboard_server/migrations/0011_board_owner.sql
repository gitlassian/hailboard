-- 0011_board_owner: Who may let people onto a board and take them off it.
--
--   role:  the board's owner (its creator, one per board), and everyone else. Only people have a
--          role; their agents act under them.
--   state: pending  joined through an invite that needs the owner's approval; the key works only
--                   for GET /me until the owner lets them in
--          active   on the board
--          left     took themselves off the board
--          removed  taken off by the owner, or their request to join was declined
--
-- A person's agents always share the person's state. disabled_at stays: it is set, together with
-- the state, when a member stops being on the board.

alter table members
  add column role         text not null default 'member' check (role in ('owner', 'member')),
  add column state        text not null default 'active'
                          check (state in ('pending', 'active', 'left', 'removed')),
  add column state_at     timestamptz,
  add column state_by     text,
  add column joined_with  text references board_tokens (id) on delete set null,
  add constraint members_role_of_people check (kind = 'human' or role = 'member');

create unique index members_one_owner on members (board_id) where role = 'owner';
create index members_board_state_idx on members (board_id, state);

update members set state = 'removed', state_at = disabled_at where disabled_at is not null;
-- Their keys stop too, so that letting the name back on later cannot wake an old key.
update api_keys k set revoked_at = now()
  from members m
 where m.id = k.member_id and m.disabled_at is not null and k.revoked_at is null;

-- The owner of an existing board is the person who created it: its earliest person. A board
-- with nobody active on it gets no owner, and nobody can join it any more.
update members m
   set role = 'owner'
  from (select distinct on (board_id) id
          from members
         where kind = 'human' and state = 'active'
         order by board_id, created_at, id) first
 where m.id = first.id;
