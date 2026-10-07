-- Outcome nudges are weekly and nothing else: Mondays at 10:00 clinic time, one
-- short message per clinic in its General channel with a count and a link.
-- No daily message, no 48h follow-up, no names, no CSR reminders or tasks.

drop view outcome_nudges_due;
drop function appointments_carry_nudges();
alter table appointments drop column nudge1_at;
alter table appointments drop column nudge2_at;

-- Where a clinic logs its outcomes. A clinic's own link wins over the default
-- (app_settings 'client_outcome_link'). With neither, no message is sent.
alter table clients add column outcome_link text;

-- Overdue = the same consults as the owner's Unlogged outcomes queue:
-- 24h+ past, no outcome, last 30 days.
create view outcome_nudges_due with (security_invoker = true) as
select
  cl.id as client_id, cl.name, cl.slack_general_id as channel,
  coalesce(cl.timezone, 'America/New_York') as timezone,
  extract(hour from (now() at time zone coalesce(cl.timezone, 'America/New_York')))::int as local_hour,
  extract(isodow from (now() at time zone coalesce(cl.timezone, 'America/New_York')))::int as local_dow,
  (now() at time zone coalesce(cl.timezone, 'America/New_York'))::date as local_date,
  count(*)::int as overdue_count,
  coalesce(nullif(cl.outcome_link, ''), (select nullif(value #>> '{}', '') from app_settings where key = 'client_outcome_link')) as link
from clients cl join appointments a on a.client_id = cl.id
where cl.deleted_at is null and cl.stage = 'live'
  and a.attendance = 'scheduled' and a.scheduled_for < now() - interval '24 hours'
  and a.scheduled_for > now() - interval '30 days'
group by cl.id, cl.name, cl.slack_general_id, cl.timezone, cl.outcome_link;
grant select on outcome_nudges_due to authenticated, service_role;

update reminder_rules
set audience = 'each clinic''s General channel (client workspace)',
    timing = 'Mondays 10:00 clinic time, only if the clinic has overdue outcomes',
    template = 'Hi [clinic] 👋 You have [X] patient outcomes waiting to be updated. Please log them here: [link]. Thanks!'
where key = 'outcome_nudge';

-- The CSR side of the outcome flow is gone, and "unconfirmed tomorrow" waits
-- for Hot Prospector. Both rules stay as rows (nothing is deleted) but can no
-- longer be switched on.
update reminder_rules set enabled = false, timing = 'Retired. Call-centre work waits for Hot Prospector.'
where key in ('outcome_overdue', 'unconfirmed_tomorrow');
alter table reminder_rules add constraint reminder_rules_retired
  check (not (enabled and key in ('outcome_overdue', 'unconfirmed_tomorrow')));
