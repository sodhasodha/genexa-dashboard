-- Reminder engine (PLAN 7a). Depends on nothing above 0024.
--
-- How it fits together (the job in lib/jobs/reminders.ts only delivers):
--   reminder_candidates(now)   what is due right now, one row per rule / person / record.
--   reminders_enqueue(now)     writes the candidates of enabled rules to notifications;
--                              the unique index on notifications refuses a repeat in the same window.
--   reminders_deliverable(now) the unsent rows that may go out now: urgent at once, everything
--                              else only inside the recipient's shift (shifts_resolved).
--   reminders_claim / _finish / _release   mark a row sent before Slack is called, so two jobs
--                              running together never send it twice.
--   slack_action(...)          the Done / Snooze 1h buttons.
--
-- p_now drives every timing decision (shift windows, 24h timers, day keys), so tests can
-- move the clock. The SLA, renewal and freshness views still read the real clock.

-- The facts a message is written from, fixed when the reminder was triggered.
alter table notifications add column payload jsonb;
create index notifications_pending_idx on notifications (created_at) where sent_at is null;
create index notifications_record_idx on notifications (record_id) where record_id is not null;

-- True when a message really went out. A row closed without sending carries
-- 'skipped:<why>' in slack_ts (and, for a DM, in channel: the convention the exception DM set).
create function notification_delivered(n notifications) returns boolean
language sql immutable as $$
  select n.sent_at is not null
    and coalesce(n.channel, '') not like 'skipped:%' and coalesce(n.slack_ts, '') not like 'skipped:%'
$$;

-- ---------------------------------------------------------------------------
-- Rules. One row per reminder; the owner can switch one off, make it urgent or
-- change its headline (template) without a deploy.
-- ---------------------------------------------------------------------------
insert into reminder_rules (key, enabled, audience, channel_or_dm, timing, template, urgent, quiet_hours_respected) values
  ('start_of_shift_digest', true,  'each staff member',            'dm', 'at their shift start', 'Start of shift', false, true),
  ('ryan_morning_digest',   true,  'owner',                        'dm', '07:00 Europe/London', 'Morning digest', false, true),
  ('eod_due',               true,  'csr, tech, media_buyer',       'dm', '30 min before shift end, and again at shift end if not submitted', 'EOD due', false, false),
  ('eod_missed',            true,  'the person + owner',           'dm', 'next shift start, from go_live_date', 'Yesterday''s EOD missing', false, true),
  ('task_due_today',        true,  'task owner',                   'dm', 'shift start', 'Due today', false, true),
  ('task_overdue',          true,  'task owner',                   'dm', 'shift start, daily while overdue', 'Overdue', false, true),
  ('task_assigned',         true,  'new task owner',               'dm', 'immediately (held to shift)', 'New task', false, true),
  ('task_snoozed',          true,  'whoever pressed Snooze 1h',    'dm', '1 hour after Snooze 1h on a task', 'Snoozed task', false, true),
  ('tech_job_new',          true,  'job owner',                    'dm', 'immediately; urgent when the job is a fix', 'New tech job', false, true),
  ('tech_job_sla_warning',  true,  'job owner',                    'dm', 'at 75% of SLA (Genexa time)', 'SLA warning', false, true),
  ('tech_job_sla_breached', true,  'job owner, then owner after 24h', 'dm', 'at breach', 'SLA breached', false, true),
  ('launch_sla_warning',    true,  'launch owner',                 'dm', '24h and 6h before the 48h launch SLA', 'Launch SLA', false, true),
  ('exception_opened',      true,  'exception owner',              'dm', 'when the exception opens (urgent types at once)', 'Exception', false, true),
  ('owner_escalation',      true,  'owner',                        'dm', 'once, 24h after the owner''s first reminder if still open', 'Still open after 24h', false, true),
  ('unconfirmed_tomorrow',  false, 'CSRs of the client''s pod',    'dm', '15:00 ET. enable once GHL appointments are syncing', 'Unconfirmed for tomorrow', false, true),
  ('outcome_overdue',       false, 'clinic channel at 24h; pod CSRs at 48h', 'channel + dm', '24h and 48h after the consult. enable once GHL appointments are syncing', 'Outcome not logged', false, true),
  ('lead_not_called',       false, 'CSRs of the client''s pod',    'dm', 'waiting for Hot Prospector', 'Lead not called', true, true),
  ('renewal_due',           true,  'owner',                        'dm', '7, 3 and 1 days before; daily once overdue (07:00 Europe/London)', 'Renewal', false, true),
  ('guarantee_deadline',    true,  'owner',                        'dm', '14 and 7 days before (07:00 Europe/London)', 'Guarantee deadline', false, true),
  ('prospect_follow_up',    true,  'owner',                        'dm', 'morning of the follow-up date (07:00 Europe/London); daily once overdue', 'Prospect follow-up', false, true),
  ('sync_failure',          true,  'owner',                        'dm', 'when a source turns stale', 'Sync failure', false, true),
  ('weekly_scorecard',      true,  'each staff member + owner',    'dm', 'Monday 09:00 ET', 'Last week''s scorecard', false, true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Where each person is in their rota at p_now.
--   last_*    the most recent shift that has started (it may have ended).
--   shift_*   that shift, only while it is still running.
--   prev_date the working day before it (whose EOD should already be in).
--   day_open  the shift-start window: the first two hours of a shift (room for a late or
--             missed run, without a "start of shift" message landing mid-afternoon). For the
--             owner with no shift entered it is 07:00 to 09:00 Europe/London.
--   day_key   the dedupe key for once-per-shift rules; day_et is "today" for due dates.
-- ---------------------------------------------------------------------------
create function reminder_staff_shift(p_now timestamptz default now())
returns table (
  staff_id uuid, name text, role text, pod text, is_owner boolean, has_shift boolean, on_shift boolean,
  shift_date date, shift_start timestamptz, shift_end timestamptz, next_start timestamptz,
  last_date date, last_start timestamptz, last_end timestamptz, prev_date date,
  day_open boolean, day_key text, day_et date)
language sql stable as $$
  select
    s.id, s.name, s.role, s.pod, (s.role = 'owner'),
    (l.starts_at is not null or nx.starts_at is not null),
    coalesce(l.ends_at > p_now, false),
    case when l.ends_at > p_now then l.date end,
    case when l.ends_at > p_now then l.starts_at end,
    case when l.ends_at > p_now then l.ends_at end,
    nx.starts_at,
    l.date, l.starts_at, l.ends_at,
    pv.date,
    case
      when l.ends_at > p_now then p_now < l.starts_at + interval '2 hours'
      when s.role = 'owner' and l.starts_at is null and nx.starts_at is null then lon.t >= time '07:00' and lon.t < time '09:00'
      else false
    end,
    case
      when l.ends_at > p_now then l.date::text
      when s.role = 'owner' and l.starts_at is null and nx.starts_at is null then lon.d::text
    end,
    case
      when l.ends_at > p_now then app_day(l.starts_at)
      when s.role = 'owner' and l.starts_at is null and nx.starts_at is null then lon.d
    end
  from staff s
  cross join (select (p_now at time zone 'Europe/London')::date as d, (p_now at time zone 'Europe/London')::time as t) lon
  left join lateral (
    select r.date, r.starts_at, r.ends_at from shifts_resolved r
    where r.staff_id = s.id and r.is_working and r.starts_at <= p_now
    order by r.starts_at desc limit 1) l on true
  left join lateral (
    select min(r.starts_at) as starts_at from shifts_resolved r
    where r.staff_id = s.id and r.is_working and r.starts_at > p_now) nx on true
  left join lateral (
    select r.date from shifts_resolved r
    where r.staff_id = s.id and r.is_working and r.starts_at < l.starts_at
    order by r.starts_at desc limit 1) pv on true
  where s.status <> 'left'
$$;

-- ---------------------------------------------------------------------------
-- The owner's morning digest. The attendance line is only there when the
-- attendance_week_flags view exists (it is added by another migration).
-- ---------------------------------------------------------------------------
create function reminder_morning_digest(p_now timestamptz default now()) returns jsonb
language plpgsql stable as $$
declare
  v jsonb;
  v_attendance jsonb;
  v_today date := (p_now at time zone 'Europe/London')::date;
begin
  select jsonb_build_object(
    'at_risk', (select coalesce(sum(e.money_at_risk), 0) from exceptions e where e.status = 'open'),
    'open_exceptions', (select count(*) from exceptions e where e.status = 'open'),
    'bottlenecks', (
      select coalesce(jsonb_agg(x.j), '[]'::jsonb) from (
        select jsonb_build_object('id', e.id, 'reason', e.reason, 'severity', e.severity,
          'money', e.money_at_risk, 'owner', o.name) as j
        from exceptions e left join staff o on o.id = e.owner_id
        where e.status = 'open'
        order by e.money_at_risk desc nulls last, e.severity desc, e.first_detected_at
        limit 5) x),
    'renewals', (
      select coalesce(jsonb_agg(jsonb_build_object('client_id', r.client_id, 'client', r.name, 'amount', r.renewal_amount,
        'date', r.renewal_date, 'days_until', r.days_until, 'status', r.status) order by r.renewal_date), '[]'::jsonb)
      from renewals r
      where r.renewal_date is not null and r.days_until <= 7 and coalesce(r.status, '') in ('due_7d', 'overdue', 'cancelling')),
    'guarantees', (
      select coalesce(jsonb_agg(jsonb_build_object('client_id', c.id, 'client', c.name, 'target', c.guarantee_target_amount,
        'deadline', c.guarantee_deadline, 'days_until', c.guarantee_deadline - v_today,
        'revenue', (select coalesce(sum(p.revenue), 0) from client_performance_daily p
                    where p.client_id = c.id and (c.launch_date is null or p.day >= c.launch_date)))
        order by c.guarantee_deadline), '[]'::jsonb)
      from clients c
      where c.deleted_at is null and c.stage <> 'churned'
        and c.guarantee_deadline between v_today and v_today + 7),
    'prospects', (
      select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'promised', p.promised,
        'days_overdue', v_today - p.follow_up_date) order by p.follow_up_date), '[]'::jsonb)
      from prospects p
      where p.deleted_at is null and p.stage in ('chase', 'contract_out') and p.follow_up_date < v_today),
    'missing_eods', (
      select coalesce(jsonb_agg(jsonb_build_object('name', e.name, 'day', e.day) order by e.name), '[]'::jsonb)
      from eod_status_7d e
      where not e.is_today and not e.filed
        and e.day = (select max(x.day) from eod_status_7d x where x.staff_id = e.staff_id and not x.is_today)),
    'stale_sources', (
      select coalesce(jsonb_agg(jsonb_build_object('source', f.source, 'last_success_at', f.last_success_at,
        'error', f.error) order by f.source), '[]'::jsonb)
      from source_freshness f where f.is_stale and f.last_success_at is not null)
  ) into v;

  if to_regclass('public.attendance_week_flags') is not null then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object('name', f.name, 'late_count', f.late_count,
        'no_show_count', f.no_show_count) order by f.name), '[]'::jsonb)
      from attendance_week_flags f where f.late_count >= 3 or f.no_show_count > 0 $q$ into v_attendance;
    v := v || jsonb_build_object('attendance', v_attendance);
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- What is due at p_now. One row per rule / recipient / record / window.
-- window_key is the dedupe window: a row is only ever written once per
-- (rule, recipient, record, window_key).
-- ---------------------------------------------------------------------------
create function reminder_candidates(p_now timestamptz default now())
returns table (rule_key text, staff_id uuid, channel text, record_type text, record_id uuid,
               window_key text, urgent boolean, payload jsonb)
language sql stable as $$
with ss as materialized (select * from reminder_staff_shift(p_now)),
own as (select ss.staff_id from ss where ss.is_owner),
-- Owner rules with a stated time run on the Europe/London day, from 07:00.
-- (The time-of-day tests are written out on p_now in each branch, so a branch outside
-- its hour is skipped without reading its views.)
lon as (select (p_now at time zone 'Europe/London')::date as d),
et as (select app_day(p_now) as d),
golive as (select (a.value #>> '{}')::date as d from app_settings a where a.key = 'go_live_date'),
open_tasks as (
  select t.id, t.owner_id, t.title, t.due, t.priority, c.name as client_name
  from tasks t left join clients c on c.id = t.client_id
  where t.deleted_at is null and t.status <> 'done'),
-- The EOD for the working day before the current shift is not in.
eod_missing as (
  select ss.staff_id, ss.name, ss.prev_date, ss.day_key
  from ss cross join golive
  where ss.on_shift and ss.day_open and ss.role in ('csr', 'tech', 'media_buyer')
    and ss.prev_date is not null and ss.prev_date >= golive.d
    and not exists (
      select 1 from eods e where e.staff_id = ss.staff_id and e.date >= ss.prev_date and e.date < ss.shift_date)),
open_jobs as (
  select j.id, coalesce(j.owner_id, app_role_holder('tech')) as owner_id, j.title, j.type, j.due_at,
         j.requested_by, j.created_at, j.legacy_ref, c.name as client_name,
         s.sla_minutes, s.genexa_minutes, s.paused_minutes, s.is_paused, s.is_overdue
  from tech_jobs j
  join tech_job_sla s on s.tech_job_id = j.id
  left join clients c on c.id = j.client_id
  where j.deleted_at is null and j.status <> 'done'),
-- Consults whose outcome nobody has logged.
unlogged as (
  select a.id, a.client_id, a.scheduled_for, c.name as client_name, c.pod, c.slack_general_id,
         nullif(split_part(btrim(coalesce(l.name, '')), ' ', 1), '') as first_name
  from appointments a
  join clients c on c.id = a.client_id and c.deleted_at is null
  left join leads l on l.id = a.lead_id
  where a.attendance = 'scheduled' and coalesce(l.is_test, false) = false),
scores as (
  select p.staff_id, s.name,
    jsonb_agg(jsonb_build_object('card', p.card, 'metric', p.metric, 'value', p.value,
      'numerator', p.numerator, 'denominator', p.denominator, 'colour', p.colour) order by p.card, p.metric) as metrics
  from person_scores_weekly p join staff s on s.id = p.staff_id and s.status <> 'left'
  cross join et
  where p.week_start = app_week_start(et.d) - 7
  group by p.staff_id, s.name),
-- First reminder and reminder count per open item and owner, for the 24h escalation.
-- An exception about a tech job counts as that job, so one job escalates once.
reminded as (
  select x.esc_type, x.esc_id, x.staff_id, min(x.sent_at) as first_sent, count(*) as times
  from (
    select n.staff_id, n.sent_at,
      case when n.rule_key = 'exception_opened' and e.record_table = 'tech_jobs' then 'tech_jobs' else n.record_type end as esc_type,
      case when n.rule_key = 'exception_opened' and e.record_table = 'tech_jobs' then e.record_id else n.record_id end as esc_id
    from notifications n
    left join exceptions e on n.rule_key = 'exception_opened' and e.id = n.record_id
    where notification_delivered(n)
      and n.staff_id is not null and n.record_id is not null
      and n.rule_key in ('exception_opened', 'task_overdue', 'tech_job_sla_breached')
      and (n.rule_key <> 'exception_opened' or e.status = 'open')
  ) x
  group by 1, 2, 3)

-- start_of_shift_digest: everything on the person's plate, once per shift. Not sent when empty.
select 'start_of_shift_digest'::text, d.staff_id, null::text, null::text, null::uuid, d.day_key, false, d.payload
from (
  select ss.staff_id, ss.day_key, jsonb_build_object(
    'tasks_due', (
      select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'client', t.client_name) order by t.title), '[]'::jsonb)
      from open_tasks t where t.owner_id = ss.staff_id and t.due = ss.day_et),
    'tasks_overdue', (
      select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'client', t.client_name,
        'days_overdue', ss.day_et - t.due) order by t.due), '[]'::jsonb)
      from open_tasks t where t.owner_id = ss.staff_id and t.due < ss.day_et),
    'exceptions', (
      select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'reason', e.reason, 'severity', e.severity,
        'money', e.money_at_risk) order by e.money_at_risk desc nulls last, e.first_detected_at), '[]'::jsonb)
      from exceptions e where e.owner_id = ss.staff_id and e.status = 'open'),
    'deadlines', (
      select coalesce(jsonb_agg(x.j order by x.at), '[]'::jsonb) from (
        select jsonb_build_object('kind', 'task', 'id', t.id, 'title', t.title, 'due', t.due) as j, t.due::timestamptz as at
        from open_tasks t where t.owner_id = ss.staff_id and t.due > ss.day_et and t.due <= ss.day_et + 2
        union all
        select jsonb_build_object('kind', 'tech_job', 'id', j.id, 'title', j.title, 'client', j.client_name, 'due_at', j.due_at), j.due_at
        from open_jobs j where j.owner_id = ss.staff_id and j.due_at > p_now and j.due_at <= p_now + interval '48 hours'
      ) x),
    'eod_missing', exists (select 1 from eod_missing m where m.staff_id = ss.staff_id)
  ) as payload
  from ss where ss.day_open
) d
where d.payload -> 'tasks_due' <> '[]'::jsonb or d.payload -> 'tasks_overdue' <> '[]'::jsonb
   or d.payload -> 'exceptions' <> '[]'::jsonb or d.payload -> 'deadlines' <> '[]'::jsonb
   or (d.payload ->> 'eod_missing')::boolean

union all
-- ryan_morning_digest
select 'ryan_morning_digest', own.staff_id, null, null, null, lon.d::text, false, reminder_morning_digest(p_now)
from own cross join lon where (p_now at time zone 'Europe/London')::time >= time '07:00'

union all
-- eod_due: 30 minutes before the shift ends, and again once it has ended.
select 'eod_due', ss.staff_id, null, 'staff', ss.staff_id,
  ss.last_date::text || case when p_now < ss.last_end then ':before' else ':end' end, false,
  jsonb_build_object('date', ss.last_date, 'shift_end', ss.last_end, 'ended', p_now >= ss.last_end)
from ss
where ss.role in ('csr', 'tech', 'media_buyer') and ss.last_end is not null
  and p_now >= ss.last_end - interval '30 minutes' and p_now < ss.last_end + interval '2 hours'
  and not exists (
    select 1 from eods e
    where e.staff_id = ss.staff_id and (e.date = ss.last_date or e.submitted_at >= ss.last_start))

union all
-- eod_missed: to the person at their next shift start...
select 'eod_missed', m.staff_id, null, 'staff', m.staff_id, m.prev_date::text, false,
  jsonb_build_object('name', m.name, 'date', m.prev_date)
from eod_missing m
union all
-- ...and to the owner.
select 'eod_missed', own.staff_id, null, 'staff', m.staff_id, m.prev_date::text, false,
  jsonb_build_object('name', m.name, 'date', m.prev_date)
from eod_missing m cross join own

union all
-- task_due_today / task_overdue: one row per task per shift.
select 'task_due_today', ss.staff_id, null, 'tasks', t.id, ss.day_key, false,
  jsonb_build_object('title', t.title, 'due', t.due, 'client', t.client_name, 'priority', t.priority)
from ss join open_tasks t on t.owner_id = ss.staff_id and t.due = ss.day_et
where ss.day_open
union all
select 'task_overdue', ss.staff_id, null, 'tasks', t.id, ss.day_key, false,
  jsonb_build_object('title', t.title, 'due', t.due, 'client', t.client_name, 'priority', t.priority,
    'days_overdue', ss.day_et - t.due)
from ss join open_tasks t on t.owner_id = ss.staff_id and t.due < ss.day_et
where ss.day_open

union all
-- task_assigned: a task someone else put on this person's list in the last 24 hours.
-- "Someone else" = the actor on the task's audit_log _created row is not the owner.
-- A server-side insert (actor "system") counts unless the task is the person's own
-- (source staff) or Ryan's on his own list.
select 'task_assigned', t.owner_id, null, 'tasks', t.id, '', false,
  jsonb_build_object('title', t.title, 'due', t.due, 'client', c.name,
    'assigned_by', case when a.actor = 'system' then initcap(t.source) else a.actor end)
from tasks t
join staff o on o.id = t.owner_id
join lateral (
  select al.actor from audit_log al
  where al.table_name = 'tasks' and al.row_id = t.id and al.field = '_created'
  order by al.at limit 1) a on true
left join clients c on c.id = t.client_id
where t.deleted_at is null and t.status <> 'done' and t.legacy_ref is null
  and t.created_at > p_now - interval '24 hours' and t.created_at <= p_now
  and a.actor <> o.name
  and not (a.actor = 'system' and (t.source = 'staff' or (t.source = 'ryan' and o.role = 'owner')))

union all
-- tech_job_new: not for a job the owner logged themselves. A fix is urgent.
select 'tech_job_new', j.owner_id, null, 'tech_jobs', j.id, '', (j.type = 'fix'),
  jsonb_build_object('title', j.title, 'type', j.type, 'client', j.client_name, 'due_at', j.due_at,
    'requested_by', (select r.name from staff r where r.id = j.requested_by))
from open_jobs j
where j.owner_id is not null and j.legacy_ref is null
  and j.created_at > p_now - interval '24 hours' and j.created_at <= p_now
  and j.requested_by is distinct from j.owner_id

union all
-- tech_job_sla_warning: 75% of the SLA used, in Genexa time.
select 'tech_job_sla_warning', j.owner_id, null, 'tech_jobs', j.id, '', false,
  jsonb_build_object('title', j.title, 'type', j.type, 'client', j.client_name, 'due_at', j.due_at,
    'minutes_left', round(j.sla_minutes - j.genexa_minutes), 'business_minutes', j.type = 'fix')
from open_jobs j
where j.owner_id is not null and j.sla_minutes is not null and not j.is_paused and not j.is_overdue
  and j.genexa_minutes >= 0.75 * j.sla_minutes

union all
-- tech_job_sla_breached. Not sent when the exception DM for the same job already went.
select 'tech_job_sla_breached', j.owner_id, null, 'tech_jobs', j.id, '', false,
  jsonb_build_object('title', j.title, 'type', j.type, 'client', j.client_name, 'due_at', j.due_at,
    'minutes_over', round(case when j.sla_minutes is not null then j.genexa_minutes - j.sla_minutes
      else extract(epoch from (p_now - j.due_at)) / 60.0 - j.paused_minutes end),
    'business_minutes', j.type = 'fix')
from open_jobs j
where j.owner_id is not null and j.is_overdue and not j.is_paused
  and not exists (
    select 1 from exceptions e
    join notifications n on n.rule_key = 'exception_opened' and n.record_id = e.id and n.staff_id = j.owner_id
    where e.record_table = 'tech_jobs' and e.record_id = j.id and e.status in ('open', 'snoozed')
      and notification_delivered(n))

union all
-- launch_sla_warning: 24h and 6h of Genexa time left on the 48h launch SLA.
select 'launch_sla_warning', coalesce(l.owner_id, app_role_holder('tech')), null, 'launches', l.id,
  case when r.left_minutes <= 360 then '6h' else '24h' end, false,
  jsonb_build_object('client', c.name, 'client_id', c.id, 'stage', b.stage, 'hours_left', round((r.left_minutes / 60.0)::numeric, 1),
    'qc_left', to_jsonb(array_remove(array[
      case when not l.qc_lead_access then 'lead access' end,
      case when not l.qc_calendar_tested then 'calendar tested' end,
      case when not l.qc_test_lead_deleted then 'test lead deleted' end,
      case when not l.qc_pixel_firing then 'pixel firing' end,
      case when not l.qc_cortana_connected then 'Cortana connected' end,
      case when not l.qc_clinic_sheet then 'clinic sheet' end], null)))
from launches l
join launch_sla s on s.launch_id = l.id
join clients c on c.id = l.client_id and c.deleted_at is null
left join launch_board b on b.launch_id = l.id
cross join lateral (select s.sla_minutes - s.genexa_minutes as left_minutes) r
where l.live_at is null and s.clock_start is not null and not s.is_paused
  and r.left_minutes > 0 and r.left_minutes <= 1440
  and coalesce(l.owner_id, app_role_holder('tech')) is not null

union all
-- unconfirmed_tomorrow: 15:00 ET, to each CSR in the clinic's pod. First names only.
select 'unconfirmed_tomorrow', ss.staff_id, null, null, null, et.d::text, false,
  jsonb_build_object('date', et.d + 1, 'count', sum(u.n),
    'clinics', jsonb_agg(jsonb_build_object('client', u.client_name, 'count', u.n, 'consults', u.consults) order by u.client_name))
from et
join (
  select x.client_id, x.client_name, x.pod, count(*) as n,
    jsonb_agg(jsonb_build_object('first_name', x.first_name, 'at', x.scheduled_for) order by x.scheduled_for) as consults
  from unlogged x cross join et
  where app_day(x.scheduled_for) = et.d + 1
  group by 1, 2, 3
) u on true
join ss on ss.role = 'csr' and ss.pod = u.pod
where (p_now at time zone 'America/New_York')::time >= time '15:00'
group by ss.staff_id, et.d

union all
-- outcome_overdue: the clinic's own channel at 24h...
select 'outcome_overdue', null, u.slack_general_id, 'appointments', u.id, '24h', false,
  jsonb_build_object('client', u.client_name, 'first_name', u.first_name, 'at', u.scheduled_for, 'stage', '24h')
from unlogged u
where u.slack_general_id is not null
  and u.scheduled_for <= p_now - interval '24 hours' and u.scheduled_for > p_now - interval '14 days'
union all
-- ...and the pod's CSRs at 48h.
select 'outcome_overdue', ss.staff_id, null, 'appointments', u.id, '48h', false,
  jsonb_build_object('client', u.client_name, 'first_name', u.first_name, 'at', u.scheduled_for, 'stage', '48h')
from unlogged u join ss on ss.role = 'csr' and ss.pod = u.pod
where u.scheduled_for <= p_now - interval '48 hours' and u.scheduled_for > p_now - interval '14 days'

union all
-- renewal_due: 7, 3 and 1 days before; daily once overdue.
select 'renewal_due', own.staff_id, null, 'clients', r.client_id,
  r.renewal_date::text || case when r.status = 'overdue' then ':overdue:' || lon.d else ':' || r.days_until end, false,
  jsonb_build_object('client', r.name, 'amount', r.renewal_amount, 'renewal_date', r.renewal_date,
    'days_until', r.days_until, 'status', r.status,
    'spend', m.spend, 'booked', m.booked, 'shows', m.shows, 'closes', m.closes)
from renewals r cross join own cross join lon
left join client_mtd m on m.client_id = r.client_id
where (p_now at time zone 'Europe/London')::time >= time '07:00' and r.renewal_date is not null
  and (coalesce(r.status, '') = 'overdue'
    or (r.days_until in (7, 3, 1) and coalesce(r.status, '') in ('due_7d', 'upcoming', 'cancelling')))

union all
-- guarantee_deadline: 14 and 7 days before. Revenue since launch as client health counts it.
select 'guarantee_deadline', own.staff_id, null, 'clients', c.id,
  c.guarantee_deadline::text || ':' || (c.guarantee_deadline - lon.d), false,
  jsonb_build_object('client', c.name, 'target', c.guarantee_target_amount, 'guarantee', c.guarantee_text,
    'deadline', c.guarantee_deadline, 'days_until', c.guarantee_deadline - lon.d,
    'revenue', coalesce(g.revenue, 0),
    'gap', greatest(c.guarantee_target_amount - coalesce(g.revenue, 0), 0))
from clients c cross join own cross join lon
left join lateral (
  select sum(p.revenue) as revenue from client_performance_daily p
  where p.client_id = c.id and (c.launch_date is null or p.day >= c.launch_date)) g on true
where (p_now at time zone 'Europe/London')::time >= time '07:00' and c.deleted_at is null and c.stage <> 'churned'
  and c.guarantee_deadline is not null and c.guarantee_deadline - lon.d in (14, 7)

union all
-- prospect_follow_up: the morning of the follow-up date, then daily while it is still open.
select 'prospect_follow_up', own.staff_id, null, 'prospects', p.id, lon.d::text, false,
  jsonb_build_object('name', p.name, 'promised', p.promised, 'follow_up_date', p.follow_up_date,
    'days_overdue', lon.d - p.follow_up_date)
from prospects p cross join own cross join lon
where (p_now at time zone 'Europe/London')::time >= time '07:00' and p.deleted_at is null and p.stage in ('chase', 'contract_out') and p.follow_up_date <= lon.d

union all
-- sync_failure: once per stale spell (keyed on the last success). Never for a source that has not synced yet.
select 'sync_failure', own.staff_id, null, null, null,
  f.source || ':' || extract(epoch from f.last_success_at)::bigint, false,
  jsonb_build_object('source', f.source, 'last_success_at', f.last_success_at, 'error', f.error)
from source_freshness f cross join own
where f.is_stale and f.last_success_at is not null

union all
-- weekly_scorecard: Monday 09:00 ET, last week. Each person gets theirs; the owner gets everyone's.
select 'weekly_scorecard', sc.staff_id, null, null, null, (app_week_start(et.d) - 7)::text, false,
  jsonb_build_object('week_start', app_week_start(et.d) - 7,
    'people', jsonb_build_array(jsonb_build_object('name', sc.name, 'metrics', sc.metrics)))
from scores sc cross join et
where extract(isodow from (p_now at time zone 'America/New_York')) = 1 and (p_now at time zone 'America/New_York')::time >= time '09:00'
union all
select 'weekly_scorecard', own.staff_id, null, null, null, (app_week_start(et.d) - 7)::text || ':all', false,
  jsonb_build_object('week_start', app_week_start(et.d) - 7, 'everyone', true,
    'people', (select jsonb_agg(jsonb_build_object('name', sc.name, 'metrics', sc.metrics) order by sc.name) from scores sc))
from own cross join et
where extract(isodow from (p_now at time zone 'America/New_York')) = 1 and (p_now at time zone 'America/New_York')::time >= time '09:00' and exists (select 1 from scores)

union all
-- owner_escalation: still open 24h after the owner's first reminder. Once per item.
select 'owner_escalation', own.staff_id, null, r.esc_type, r.esc_id, '', false,
  jsonb_build_object('kind', r.esc_type, 'owner', s.name, 'times', r.times, 'first_sent', r.first_sent,
    'title', coalesce(t.title, j.title, e.reason),
    'days_overdue', case when t.id is not null then app_day(p_now) - t.due end)
from reminded r
join staff s on s.id = r.staff_id and s.role <> 'owner'
cross join own
left join tasks t on r.esc_type = 'tasks' and t.id = r.esc_id and t.deleted_at is null and t.status <> 'done'
left join tech_jobs j on r.esc_type = 'tech_jobs' and j.id = r.esc_id and j.deleted_at is null and j.status <> 'done'
left join exceptions e on r.esc_type = 'exceptions' and e.id = r.esc_id and e.status = 'open'
where r.first_sent <= p_now - interval '24 hours'
  and (t.id is not null or j.id is not null or e.id is not null)
$$;

-- ---------------------------------------------------------------------------
-- Queue what is due. Held rows carry the next shift start in held_until.
-- A person with no shift entered is queued nothing except urgent rules; the
-- owner with no shift entered gets owner messages at their stated time.
-- ---------------------------------------------------------------------------
create function reminders_enqueue(p_now timestamptz default now()) returns integer
language plpgsql as $$
declare v_count integer;
begin
  insert into notifications (rule_key, staff_id, channel, record_type, record_id, window_key, held_until, payload, created_at)
  select c.rule_key, c.staff_id, c.channel, c.record_type, c.record_id, c.window_key,
    case when c.staff_id is null or c.urgent or r.urgent or not r.quiet_hours_respected or ss.on_shift
      then null else ss.next_start end,
    c.payload || case when c.urgent then '{"_urgent": true}'::jsonb else '{}'::jsonb end,
    p_now
  from reminder_candidates(p_now) c
  join reminder_rules r on r.key = c.rule_key and r.enabled
  left join reminder_staff_shift(p_now) ss on ss.staff_id = c.staff_id
  where (c.staff_id is null and c.channel is not null)
     or (ss.staff_id is not null
         and (c.urgent or r.urgent or not r.quiet_hours_respected or ss.has_shift or ss.is_owner))
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- What may be sent now. Also closes rows that no longer need sending
-- (sent_at set and 'skipped:<why>' recorded; see notification_delivered).
-- Returns { held: n, items: [...] }.
-- ---------------------------------------------------------------------------
create function reminders_deliverable(p_now timestamptz default now(), p_rule text default null) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  -- The record was dealt with before the reminder could go.
  update notifications n set sent_at = p_now, slack_ts = 'skipped:resolved',
    channel = case when n.staff_id is null then n.channel else 'skipped:resolved' end
  where n.sent_at is null and (p_rule is null or n.rule_key = p_rule) and (
    (n.rule_key = 'exception_opened' and exists (select 1 from exceptions e where e.id = n.record_id and e.status = 'resolved'))
    or (n.record_type = 'tasks' and exists (select 1 from tasks t where t.id = n.record_id and (t.status = 'done' or t.deleted_at is not null)))
    or (n.record_type = 'tech_jobs' and exists (select 1 from tech_jobs j where j.id = n.record_id and (j.status = 'done' or j.deleted_at is not null)))
    or (n.record_type = 'appointments' and exists (select 1 from appointments a where a.id = n.record_id and a.attendance <> 'scheduled'))
    or (n.rule_key = 'eod_due' and exists (
          select 1 from eods e where e.staff_id = n.staff_id and e.date >= (n.payload ->> 'date')::date)));

  -- The breach reminder for the same tech job already reached this person.
  update notifications n set sent_at = p_now, slack_ts = 'skipped:duplicate',
    channel = case when n.staff_id is null then n.channel else 'skipped:duplicate' end
  from exceptions e
  where n.sent_at is null and n.rule_key = 'exception_opened' and (p_rule is null or n.rule_key = p_rule)
    and e.id = n.record_id and e.record_table = 'tech_jobs'
    and exists (
      select 1 from notifications b
      where b.rule_key = 'tech_job_sla_breached' and b.record_id = e.record_id and b.staff_id = n.staff_id
        and notification_delivered(b));

  -- Too old to be worth saying. Exception DMs keep waiting for a shift to be entered.
  update notifications n set sent_at = p_now, slack_ts = 'skipped:expired',
    channel = case when n.staff_id is null then n.channel else 'skipped:expired' end
  where n.sent_at is null and n.rule_key <> 'exception_opened' and (p_rule is null or n.rule_key = p_rule)
    and n.created_at < p_now - interval '7 days';

  select jsonb_build_object(
    'held', count(*) filter (where not q.ready),
    'items', coalesce(jsonb_agg(q.item order by q.created_at, q.id) filter (where q.ready), '[]'::jsonb))
  into v
  from (
    select n.id, n.created_at,
      (coalesce(n.held_until <= p_now, true)
        and (n.staff_id is null
          or r.urgent or not r.quiet_hours_respected
          or coalesce((n.payload ->> '_urgent')::boolean, false)
          or coalesce(xr.urgent, false)
          or ss.on_shift
          or (ss.is_owner and not ss.has_shift))) as ready,
      jsonb_build_object(
        'id', n.id, 'rule_key', n.rule_key, 'staff_id', n.staff_id, 'staff_name', s.name,
        'slack_user_id', s.slack_user_id, 'email', s.email, 'channel', n.channel,
        'record_type', n.record_type, 'record_id', n.record_id, 'window_key', n.window_key,
        'template', r.template,
        'payload', coalesce(n.payload, case when e.id is not null then
          jsonb_build_object('reason', e.reason, 'severity', e.severity, 'money', e.money_at_risk, 'type', e.type) end,
          '{}'::jsonb)) as item
    from notifications n
    join reminder_rules r on r.key = n.rule_key and r.enabled
    left join staff s on s.id = n.staff_id
    left join reminder_staff_shift(p_now) ss on ss.staff_id = n.staff_id
    left join exceptions e on n.rule_key = 'exception_opened' and e.id = n.record_id
    left join exception_rules xr on xr.type = e.type
    where n.sent_at is null and (p_rule is null or n.rule_key = p_rule)
      and (n.staff_id is null or ss.staff_id is not null)
      and (n.staff_id is not null or n.channel is not null)
    order by n.created_at, n.id
    limit 300
  ) q;
  return v;
end $$;

-- Mark rows sent before Slack is called. Returns the ids this caller won.
create function reminders_claim(p_ids uuid[], p_now timestamptz default now()) returns uuid[]
language sql as $$
  with u as (
    update notifications set sent_at = p_now where id = any (p_ids) and sent_at is null returning id)
  select coalesce(array_agg(u.id), '{}') from u
$$;

create function reminders_finish(p_ids uuid[], p_ts text, p_channel text) returns void
language sql as $$
  -- A channel message keeps its channel id: it is part of the dedupe key.
  update notifications set slack_ts = p_ts, channel = case when staff_id is null then channel else p_channel end
  where id = any (p_ids)
$$;

-- Slack refused the message: put the rows back so the next run tries again.
create function reminders_release(p_ids uuid[]) returns void
language sql as $$
  update notifications set sent_at = null where id = any (p_ids) and slack_ts is null
$$;

create function reminders_set_slack_id(p_staff uuid, p_slack_user text) returns void
language sql as $$
  update staff set slack_user_id = p_slack_user where id = p_staff and slack_user_id is null
$$;

-- ---------------------------------------------------------------------------
-- The Done / Snooze 1h buttons. Only the record's owner (for an exception, also
-- its pod) or the app owner may act. The change is audited under the person's name.
-- Returns { result, actor, title } with result one of:
--   done, snoozed, already_done, refused, unknown_user, not_found, bad_request.
-- ---------------------------------------------------------------------------
create function slack_action(p_slack_user text, p_action text, p_record_type text, p_record_id uuid,
                             p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v staff%rowtype;
  t tasks%rowtype;
  e exceptions%rowtype;
  v_result text;
  v_title text;
  v_owner uuid;
begin
  select * into v from staff where slack_user_id = p_slack_user and status <> 'left' order by created_at limit 1;
  if not found then return jsonb_build_object('result', 'unknown_user'); end if;
  if p_action not in ('done', 'snooze') or p_record_type not in ('tasks', 'exceptions') then
    return jsonb_build_object('result', 'bad_request', 'actor', v.name);
  end if;

  if p_record_type = 'tasks' then
    select * into t from tasks where id = p_record_id and deleted_at is null;
    if not found then return jsonb_build_object('result', 'not_found', 'actor', v.name); end if;
    v_title := t.title;
    v_owner := t.owner_id;
    if t.owner_id <> v.id and v.role <> 'owner' then
      return jsonb_build_object('result', 'refused', 'actor', v.name, 'title', v_title);
    end if;
    perform set_config('app.actor', v.name, true);
    if t.status = 'done' then
      v_result := 'already_done';
    elsif p_action = 'done' then
      update tasks set status = 'done' where id = t.id;
      v_result := 'done';
    else
      -- The task itself is untouched: a fresh reminder waits one hour.
      insert into notifications (rule_key, staff_id, record_type, record_id, window_key, held_until, payload, created_at)
      values ('task_snoozed', v.id, 'tasks', t.id, 'snooze:' || to_char(p_now at time zone 'UTC', 'YYYYMMDD"T"HH24MISS'),
        p_now + interval '1 hour',
        jsonb_build_object('title', t.title, 'due', t.due,
          'client', (select c.name from clients c where c.id = t.client_id)), p_now)
      on conflict do nothing;
      v_result := 'snoozed';
    end if;
  else
    select * into e from exceptions where id = p_record_id;
    if not found then return jsonb_build_object('result', 'not_found', 'actor', v.name); end if;
    v_title := e.reason;
    v_owner := e.owner_id;
    if not (e.owner_id is not distinct from v.id or v.role = 'owner'
            or (e.owner_pod is not null and e.owner_pod = v.pod)) then
      return jsonb_build_object('result', 'refused', 'actor', v.name, 'title', v_title);
    end if;
    perform set_config('app.actor', v.name, true);
    if e.status = 'resolved' then
      v_result := 'already_done';
    elsif p_action = 'done' then
      update exceptions set status = 'resolved', resolved_at = p_now, resolved_by = v.name,
        resolution_note = 'Marked done from Slack', snoozed_until = null
      where id = e.id;
      v_result := 'done';
    else
      update exceptions set status = 'snoozed', snoozed_until = p_now + interval '1 hour',
        snooze_reason = 'Snoozed from Slack'
      where id = e.id;
      v_result := 'snoozed';
    end if;
  end if;

  update notifications n set acknowledged_at = p_now
  where n.record_id = p_record_id and n.record_type = p_record_type
    and n.sent_at is not null and n.acknowledged_at is null
    and (n.staff_id = v.id or n.staff_id = v_owner);
  perform set_config('app.actor', '', true);
  return jsonb_build_object('result', v_result, 'actor', v.name, 'title', v_title);
end $$;

-- ---------------------------------------------------------------------------
-- "Reminded N times" for a record: messages that actually went out.
-- ---------------------------------------------------------------------------
create view record_reminders with (security_invoker = true) as
select n.record_type, n.record_id, n.staff_id,
  count(*) as times_reminded,
  min(n.sent_at) as first_sent_at,
  max(n.sent_at) as last_sent_at,
  max(n.acknowledged_at) as acknowledged_at
from notifications n
where notification_delivered(n) and n.record_id is not null
group by n.record_type, n.record_id, n.staff_id;

grant select on record_reminders to authenticated, service_role;

-- Only the server (service role) runs the engine and the button handler.
do $$
declare f text;
begin
  foreach f in array array[
    'reminder_staff_shift(timestamptz)', 'reminder_morning_digest(timestamptz)', 'reminder_candidates(timestamptz)',
    'reminders_enqueue(timestamptz)', 'reminders_deliverable(timestamptz, text)',
    'reminders_claim(uuid[], timestamptz)', 'reminders_finish(uuid[], text, text)', 'reminders_release(uuid[])',
    'reminders_set_slack_id(uuid, text)', 'slack_action(text, text, text, uuid, timestamptz)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
