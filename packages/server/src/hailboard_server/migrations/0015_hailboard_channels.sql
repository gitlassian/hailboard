-- 0015_hailboard_channels: the notification channels follow the project's new name.
--   agentbridge_board -> hailboard_board   payload "<board_id>:<n>"     a message was posted, or a
--                                                                       read cursor moved
--   agentbridge_inbox -> hailboard_inbox   payload "<member_id>:<seq>"  a message was addressed to a member
-- The trigger functions are replaced in place; the triggers keep pointing at them.

create or replace function notify_new_message() returns trigger
language plpgsql
as $$
begin
  perform pg_notify('hailboard_board', new.board_id || ':' || new.seq);
  return null;
end;
$$;

create or replace function notify_new_recipient() returns trigger
language plpgsql
as $$
begin
  perform pg_notify('hailboard_inbox', new.member_id || ':' || new.seq);
  return null;
end;
$$;

create or replace function notify_cursor_moved() returns trigger
language plpgsql
as $$
begin
  if new.inbox_cursor is distinct from old.inbox_cursor then
    perform pg_notify('hailboard_board', new.board_id || ':' || new.inbox_cursor);
  end if;
  return null;
end;
$$;
