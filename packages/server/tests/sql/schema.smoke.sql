-- Smoke test for the database schema. Run against an empty database after the migrations:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/server/test/schema.smoke.sql
--
-- Everything runs in one transaction that is rolled back at the end, so it leaves no data.
-- Any failed expectation raises an exception and aborts the run.

begin;

-- Expect a statement to fail with a given SQLSTATE class; fail the test if it succeeds.
create function pg_temp.expect_error(stmt text, expected_state text) returns void
language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    if sqlstate = expected_state then
      return;
    end if;
    raise exception 'expected SQLSTATE % but got % (%) for: %', expected_state, sqlstate, sqlerrm, stmt;
  end;
  raise exception 'expected failure (%) but statement succeeded: %', expected_state, stmt;
end;
$$;

-- Fixture: two boards, each with members
insert into boards (id, name) values ('brd_t1', 'team one'), ('brd_t2', 'team two');

insert into members (id, board_id, handle, kind, owner) values
  ('mem_alice',  'brd_t1', 'alice',        'human', 'alice'),
  ('mem_aclaude','brd_t1', 'alice/claude', 'agent', 'alice'),
  ('mem_bob',    'brd_t1', 'bob',          'human', 'bob'),
  ('mem_bcodex', 'brd_t1', 'bob/codex',    'agent', 'bob'),
  ('mem_carol',  'brd_t2', 'carol',        'human', 'carol');

-- 1. Handle and owner rules
select pg_temp.expect_error($$insert into members (board_id, handle, kind, owner) values ('brd_t1', 'Dave', 'human', 'Dave')$$, '23514');
select pg_temp.expect_error($$insert into members (board_id, handle, kind, owner) values ('brd_t1', 'all', 'human', 'all')$$, '23514');
select pg_temp.expect_error($$insert into members (board_id, handle, kind, owner) values ('brd_t1', 'human', 'human', 'human')$$, '23514');
select pg_temp.expect_error($$insert into members (board_id, handle, kind, owner) values ('brd_t1', 'dave/claude', 'agent', 'erin')$$, '23514');
select pg_temp.expect_error($$insert into members (board_id, handle, kind, owner) values ('brd_t1', 'dave', 'agent', 'dave')$$, '23514');
select pg_temp.expect_error($$insert into members (board_id, handle, kind, owner) values ('brd_t1', 'erin', 'human', 'dave')$$, '23514');
select pg_temp.expect_error($$insert into members (board_id, handle, kind, owner) values ('brd_t1', 'alice', 'human', 'alice')$$, '23505');  -- duplicate handle
insert into members (board_id, handle, kind, owner) values ('brd_t2', 'alice', 'human', 'alice');                                          -- same handle on another board is fine

-- 2. Generated ids and defaults
do $$
declare mid text;
begin
  insert into members (board_id, handle, kind, owner) values ('brd_t1', 'frank', 'human', 'frank') returning id into mid;
  if mid !~ '^mem_[0-9a-f]{32}$' then raise exception 'unexpected generated id %', mid; end if;
end $$;

-- 3. Per-board gapless numbering; a supplied seq is ignored
do $$
declare s1 bigint; s2 bigint; s3 bigint; s_other bigint;
begin
  insert into messages (board_id, author_id, body) values ('brd_t1', 'mem_aclaude', 'first')  returning seq into s1;
  insert into messages (board_id, seq, author_id, body) values ('brd_t1', 999, 'mem_bcodex', 'second') returning seq into s2;
  insert into messages (board_id, author_id, body, reply_to_seq) values ('brd_t1', 'mem_aclaude', 'third', 2) returning seq into s3;
  insert into messages (board_id, author_id, body) values ('brd_t2', 'mem_carol', 'other board') returning seq into s_other;

  if (s1, s2, s3) is distinct from (1::bigint, 2::bigint, 3::bigint) then
    raise exception 'expected seq 1,2,3 got %,%,%', s1, s2, s3;
  end if;
  if s_other <> 1 then raise exception 'second board must start at 1, got %', s_other; end if;
  if (select last_seq from boards where id = 'brd_t1') <> 3 then raise exception 'boards.last_seq not updated'; end if;
end $$;

-- 4. Message integrity
select pg_temp.expect_error($$insert into messages (board_id, author_id, body) values ('brd_t1', 'mem_carol', 'wrong board author')$$, '23503');
select pg_temp.expect_error($$insert into messages (board_id, author_id, body) values ('brd_nope', 'mem_alice', 'no such board')$$, '23503');
-- A reply may only point at an earlier message. Numbering is gapless, so a reply to a
-- missing message is always a reply to a not-yet-existing (later) number.
select pg_temp.expect_error($$insert into messages (board_id, author_id, body, reply_to_seq) values ('brd_t1', 'mem_alice', 'reply to future', 42)$$, '23514');
select pg_temp.expect_error($$insert into messages (board_id, author_id, body, reply_to_seq) values ('brd_t1', 'mem_alice', 'reply to itself', 4)$$, '23514');
select pg_temp.expect_error($$insert into messages (board_id, author_id, body) values ('brd_t1', 'mem_alice', '')$$, '23514');
select pg_temp.expect_error($$insert into messages (board_id, author_id, body) values ('brd_t1', 'mem_alice', repeat('x', 8001))$$, '23514');
select pg_temp.expect_error($$insert into messages (board_id, author_id, body, kind) values ('brd_t1', 'mem_alice', 'x', 'shout')$$, '23514');

-- 5. Recipients must belong to the same board
select pg_temp.expect_error($$insert into message_recipients (board_id, seq, member_id, reason) values ('brd_t1', 1, 'mem_carol', 'mention')$$, '23503');

-- 6. Inbox: alice/claude asks bob/codex (mention), bob/codex replies (reply), @human ping
insert into message_recipients (board_id, seq, member_id, reason) values
  ('brd_t1', 1, 'mem_bcodex', 'mention'),     -- #1 from alice/claude -> @bob/codex
  ('brd_t1', 3, 'mem_bcodex', 'reply'),       -- #3 replies to #2 (authored by bob/codex)
  ('brd_t1', 3, 'mem_alice',  'human');       -- #3 also pings humans

-- Atomic take (reference query from the migration): bob/codex gets #1 and #3, in order
do $$
declare got bigint[]; got2 bigint[];
begin
  with me as (
    select id, board_id, inbox_cursor from members where id = 'mem_bcodex' for update
  ), taken as (
    select m.seq
      from me
      join message_recipients r on r.member_id = me.id and r.seq > me.inbox_cursor
      join messages m on m.board_id = r.board_id and m.seq = r.seq
     order by r.seq
     limit 50
  ), moved as (
    update members set inbox_cursor = coalesce((select max(seq) from taken), inbox_cursor) where id = 'mem_bcodex'
  )
  select array_agg(seq order by seq) into got from taken;

  if got is distinct from array[1, 3]::bigint[] then raise exception 'inbox take returned %', got; end if;
  if (select inbox_cursor from members where id = 'mem_bcodex') <> 3 then raise exception 'cursor not advanced'; end if;

  -- second take returns nothing and leaves the cursor alone
  with me as (
    select id, board_id, inbox_cursor from members where id = 'mem_bcodex' for update
  ), taken as (
    select r.seq from me join message_recipients r on r.member_id = me.id and r.seq > me.inbox_cursor
  )
  select array_agg(seq) into got2 from taken;
  if got2 is not null then raise exception 'second take returned %', got2; end if;
end $$;

-- 7. Tokens and API keys
select pg_temp.expect_error($$insert into board_tokens (board_id, scope, token_hash) values ('brd_t1', 'admin', '\x00'::bytea)$$, '23514');
select pg_temp.expect_error($$insert into board_tokens (board_id, scope, token_hash) values ('brd_t1', 'join', '\x0102'::bytea)$$, '23514');  -- not 32 bytes
insert into board_tokens (board_id, scope, token_hash) values ('brd_t1', 'join', decode(repeat('ab', 32), 'hex'));
select pg_temp.expect_error($$insert into board_tokens (board_id, scope, token_hash) values ('brd_t2', 'read', decode(repeat('ab', 32), 'hex'))$$, '23505');  -- hash is unique
insert into api_keys (member_id, key_hash) values ('mem_aclaude', decode(repeat('cd', 32), 'hex'));

-- 8. Zones (migration 0002)
insert into zones (board_id, member_id, path_glob) values ('brd_t1', 'mem_aclaude', 'apps/web/**');
select pg_temp.expect_error($$insert into zones (board_id, member_id, path_glob) values ('brd_t1', 'mem_aclaude', 'apps/web/**')$$, '23505');
select pg_temp.expect_error($$insert into zones (board_id, member_id, path_glob) values ('brd_t1', 'mem_carol', 'x/**')$$, '23503');

-- 9. Members with messages cannot be deleted; deleting a board removes everything
select pg_temp.expect_error($$delete from members where id = 'mem_aclaude'$$, '23503');
delete from boards where id = 'brd_t1';
do $$
begin
  if exists (select 1 from members where board_id = 'brd_t1')
     or exists (select 1 from messages where board_id = 'brd_t1')
     or exists (select 1 from message_recipients where board_id = 'brd_t1')
     or exists (select 1 from zones where board_id = 'brd_t1')
     or exists (select 1 from api_keys where member_id = 'mem_aclaude') then
    raise exception 'board delete did not cascade';
  end if;
end $$;

rollback;

\echo schema smoke test passed
