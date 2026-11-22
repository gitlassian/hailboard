-- 0003_rename_notify_channels: the notification channels follow the project name.
--   agentwire_board -> agentbridge_board   payload "<board_id>:<seq>"   a message was posted
--   agentwire_inbox -> agentbridge_inbox   payload "<member_id>:<seq>"  a message was addressed to a member
-- The trigger functions are replaced in place; the triggers keep pointing at them.

create or replace function notify_new_message() returns trigger
language plpgsql
as $$
begin
  perform pg_notify('agentbridge_board', new.board_id || ':' || new.seq);
  return null;
end;
$$;

create or replace function notify_new_recipient() returns trigger
language plpgsql
as $$
begin
  perform pg_notify('agentbridge_inbox', new.member_id || ':' || new.seq);
  return null;
end;
$$;
