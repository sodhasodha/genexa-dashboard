-- Wiring after the attendance, payroll, reminders, MCP and report work.

-- One scorecard view for every role, now with attendance.
create or replace view person_scores_weekly with (security_invoker = true) as
select
  s.staff_id, s.week_start, s.card, s.metric, s.value, s.numerator, s.denominator, s.colour,
  coalesce(s.week_start = app_week_start(
    (select (value #>> '{}')::date from app_settings where key = 'go_live_date')), false) as is_baseline
from (
  select staff_id, week_start, card, metric, value, numerator, denominator, colour from score_eods_weekly
  union all
  select staff_id, week_start, card, metric, value, numerator, denominator, colour from score_attendance_weekly
  union all
  select staff_id, week_start, card, metric, value, numerator, denominator, colour from score_tech_weekly
  union all
  select staff_id, week_start, card, metric, value, numerator, denominator, colour from score_media_weekly
) s;

-- ---------------------------------------------------------------------------
-- Two Slack workspaces. The team workspace gets alerts, reminders, digests and
-- buttons. The client workspace is listen-only: the app never queues a message
-- for a client channel. Its only possible output is a thread reply from the
-- request router, and only while this setting is on.
-- ---------------------------------------------------------------------------
insert into app_settings (key, value) values ('client_workspace_thread_replies', 'false')
on conflict (key) do nothing;

-- No reminder, alert or digest can be queued for a client's channel, whatever a rule says.
create function notifications_block_client_channels() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.channel is not null and exists (
    select 1 from clients c where new.channel in (c.slack_general_id, c.slack_scheduling_id)
  ) then
    return null;
  end if;
  return new;
end $$;
create trigger notifications_block_client_channels before insert or update of channel on notifications
  for each row execute function notifications_block_client_channels();

update reminder_rules
set enabled = false,
    audience = 'pod CSRs at 48h (nothing is ever sent to a clinic channel: clients are in a separate workspace)',
    channel_or_dm = 'dm'
where key = 'outcome_overdue';
