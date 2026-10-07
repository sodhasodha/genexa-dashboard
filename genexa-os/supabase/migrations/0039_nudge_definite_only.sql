-- The Monday message counts only consults that are definitely unlogged. A consult
-- is counted when all of these hold; otherwise it is left out (uncertain_count):
--   1. it has a phone or email to match on;
--   2. Cortana knows that patient at that clinic under the same phone or email,
--      so an outcome logged for them would have matched;
--   3. no outcome at that clinic since the consult carries the same first name
--      (it may be the same patient logged under another number);
--   4. the clinic has logged at least one outcome in the last 30 days, which
--      proves its outcomes reach us at all.
drop view outcome_nudges_due;
create view outcome_nudges_due with (security_invoker = true) as
with oe as (
  select e.client_id, e.occurred_at, lower(split_part(btrim(e.contact_first_name), ' ', 1)) as first_name
  from cortana_events e
  where e.event in ('appointment_shown', 'appointment_no_show', 'appointment_cancelled') and e.occurred_at > now() - interval '30 days'
),
a as (
  select ap.client_id,
    (ap.contact_key is not null
      and exists (select 1 from cortana_events e where e.client_id = ap.client_id and e.contact_key = ap.contact_key)
      and not exists (select 1 from oe where oe.client_id = ap.client_id and oe.occurred_at > ap.scheduled_for - interval '12 hours'
                        and oe.first_name = lower(split_part(btrim(ap.contact_first_name), ' ', 1)))
      and exists (select 1 from oe where oe.client_id = ap.client_id)) as definite
  from appointments ap
  where ap.attendance = 'scheduled' and ap.scheduled_for < now() - interval '24 hours' and ap.scheduled_for > now() - interval '30 days'
)
select
  cl.id as client_id, cl.name, cl.slack_general_id as channel,
  coalesce(cl.timezone, 'America/New_York') as timezone,
  extract(hour from (now() at time zone coalesce(cl.timezone, 'America/New_York')))::int as local_hour,
  extract(isodow from (now() at time zone coalesce(cl.timezone, 'America/New_York')))::int as local_dow,
  (now() at time zone coalesce(cl.timezone, 'America/New_York'))::date as local_date,
  (count(*) filter (where a.definite))::int as overdue_count,
  (count(*) filter (where not a.definite))::int as uncertain_count,
  coalesce(nullif(cl.outcome_link, ''), (select nullif(value #>> '{}', '') from app_settings where key = 'client_outcome_link')) as link
from clients cl join a on a.client_id = cl.id
where cl.deleted_at is null and cl.stage = 'live'
group by cl.id, cl.name, cl.slack_general_id, cl.timezone, cl.outcome_link;
grant select on outcome_nudges_due to authenticated, service_role;
