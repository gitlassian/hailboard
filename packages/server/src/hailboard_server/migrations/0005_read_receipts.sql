-- 0005_read_receipts: announce when a member's read cursor moves, so the web feed can show
-- "seen by" under a message as soon as it reaches the addressee.
--
-- The payload has the same "<board_id>:<n>" form as a new message on agentbridge_board. A
-- listener only uses it as a hint to re-read the board, so it wakes the feed without a new channel.

create function notify_cursor_moved() returns trigger
language plpgsql
as $$
begin
  if new.inbox_cursor is distinct from old.inbox_cursor then
    perform pg_notify('agentbridge_board', new.board_id || ':' || new.inbox_cursor);
  end if;
  return null;
end;
$$;

create trigger members_cursor_notify
  after update of inbox_cursor on members
  for each row execute function notify_cursor_moved();
