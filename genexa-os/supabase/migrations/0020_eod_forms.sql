-- EOD forms: who filed on which day, and what blocked the call centre.
-- Depends on nothing above 0014. No table changes: answers stay in eods.answers
-- (shapes documented in lib/eod/schema.ts).

-- One row per person per day they were expected to file, for the last 7 days.
-- A day is the person's own calendar day (eods.date is cut in their timezone,
-- see eods_rules), so the window is each person's local today and the 6 days before.
-- Only listed: days in staff.working_days, on or after staff.start_date, and on or
-- after app_settings.go_live_date. With no go-live date the view is empty: the form
-- did not exist, so nothing is missing.
-- is_today marks the day that is still open (not filed there means "due", not "missed").
create view eod_status_7d with (security_invoker = true) as
select
  s.id as staff_id,
  s.name,
  s.role,
  d.day::date as day,
  (e.id is not null) as filed,
  e.submitted_at,
  e.id as eod_id,
  (d.day::date = t.today) as is_today
from staff s
cross join lateral (select (now() at time zone s.timezone)::date as today) t
cross join lateral generate_series(t.today - 6, t.today, interval '1 day') as d(day)
left join eods e on e.staff_id = s.id and e.date = d.day::date
where s.status <> 'left'
  and s.role in ('csr', 'tech', 'media_buyer')
  and extract(isodow from d.day)::smallint = any (s.working_days)
  and (s.start_date is null or d.day::date >= s.start_date)
  and d.day::date >= (select (value #>> '{}')::date from app_settings where key = 'go_live_date');

-- How often each blocker was named by each CSR, per week (Monday to Sunday).
-- Context for the Call Centre page, never a score. "none" is not a blocker and is left out.
create view eod_blockers_weekly with (security_invoker = true) as
select
  e.staff_id,
  app_week_start(e.date) as week_start,
  e.answers ->> 'blocker' as blocker,
  count(*)::int as count
from eods e
where e.role = 'csr'
  and e.answers ->> 'blocker' is not null
  and e.answers ->> 'blocker' <> 'none'
group by 1, 2, 3;
