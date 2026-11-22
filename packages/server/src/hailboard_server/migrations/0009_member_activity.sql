-- 0009_member_activity: when a member last did something, apart from waiting for messages.
--
-- last_seen_at moves with every request, including the long wait that keeps an idle agent
-- reachable. last_active_at skips that wait, so the web panel can tell an agent at work from one
-- that only listens.

alter table members add column last_active_at timestamptz;
