-- Task deadlines to the minute.
--
-- Tasks owned by the media buyer and the tech person ("timed-deadline staff": decided by
-- role in staff_has_timed_deadlines, one place to change) carry a date AND time deadline in
-- tasks.due_at. Everyone else keeps the optional date in tasks.due; a time is optional.
--
--   * tasks.due stays in step with due_at (the ET day of the deadline), so every older view
--     and reminder that reads the date keeps working.
--   * A logged-in person cannot save a task for timed-deadline staff without a deadline
--     (TASK_DEADLINE_REQUIRED). Server-side callers (router, MCP, imports) never fail on it:
--     a date alone becomes 17:00 that day in the owner's timezone, nothing at all becomes
--     the end of the owner's next shift.
--   * Status and group changes are never blocked, so the staff member can always progress
--     or finish their own task, including an old one with no deadline.
--   * Overdue is to the minute for a task with due_at; the day rule stays for the rest.
--
-- Shared objects redefined here (previous definition in brackets), each a copy of the latest
-- text with only the task parts changed:
--   task_list, task_owners (0018)        new columns appended; overdue to the minute
--   reminder_candidates (0027)           task branches only
--   person_scores_weekly (0033)          one more union arm
--   route_client_request (0035)          the two inserts carry the deadline
--   tech_job_sla (0003), tech_jobs_board (0016)   deadline override

-- ---------------------------------------------------------------------------
-- Who has timed deadlines, their timezone, and the end of their next shift
-- ---------------------------------------------------------------------------
create function staff_has_timed_deadlines(p_role text) returns boolean
language sql immutable as $$
  select coalesce(p_role in ('media_buyer', 'tech'), false)
$$;

-- The person's own timezone (staff.timezone, the one the roster uses); Europe/London if unknown.
create function staff_tz(p_staff uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select nullif(btrim(s.timezone), '') from staff s where s.id = p_staff), 'Europe/London')
$$;

-- The default deadline when nobody gave one: the end of the person's next shift.
-- "Next" = the shift in progress when at least two hours of it are left, otherwise the one
-- after. With no shift entered (or none in the next 14 days): the next weekday 17:00 in the
-- person's timezone that is at least two hours away.
create function staff_next_shift_end(p_staff uuid, p_now timestamptz default now()) returns timestamptz
language sql stable as $$
  select coalesce(
    (select min(r.ends_at) from shifts_resolved r
     where r.staff_id = p_staff and r.is_working and r.ends_at >= p_now + interval '2 hours'),
    (select min((g.d::date + time '17:00') at time zone z.tz)
     from (select staff_tz(p_staff) as tz) z
     cross join lateral generate_series(
       (p_now at time zone z.tz)::date::timestamp, (p_now at time zone z.tz)::date::timestamp + interval '7 days', interval '1 day') g(d)
     where extract(isodow from g.d) < 6
       and ((g.d::date + time '17:00') at time zone z.tz) >= p_now + interval '2 hours'))
$$;

-- ---------------------------------------------------------------------------
-- tasks.due_at
-- ---------------------------------------------------------------------------
alter table tasks add column due_at timestamptz;
create index tasks_due_at_idx on tasks (due_at) where deleted_at is null and due_at is not null;

-- Existing rows. An open task for timed-deadline staff that has a date gets 17:00 that day
-- in its owner's timezone. A task with no date at all is left alone: inventing a deadline
-- would mark old work late. It is asked for a deadline the next time a person edits it.
select set_config('app.actor', 'task-deadlines-migration', false);
update tasks t
set due_at = (t.due + time '17:00') at time zone staff_tz(t.owner_id)
from staff s
where s.id = t.owner_id and staff_has_timed_deadlines(s.role)
  and t.due is not null and t.due_at is null and t.deleted_at is null and t.status <> 'done';
select set_config('app.actor', '', false);

-- Runs after tasks_rules (triggers fire in name order), so the existing rules and their
-- errors come first and are unchanged.
create function tasks_deadline() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_timed boolean;
  v_tz text;
  -- A logged-in person (the app). Server-side callers carry no user id.
  v_person boolean := auth.uid() is not null;
  v_live boolean := new.status <> 'done' and new.deleted_at is null;
begin
  select staff_has_timed_deadlines(s.role), coalesce(nullif(btrim(s.timezone), ''), 'Europe/London')
    into v_timed, v_tz from staff s where s.id = new.owner_id;

  if tg_op = 'INSERT' then
    if new.due_at is not null then
      new.due := coalesce(new.due, app_day(new.due_at));
    elsif v_timed and v_live and new.legacy_ref is null then
      if v_person then
        raise exception 'TASK_DEADLINE_REQUIRED: this person''s tasks need a deadline with a date and a time' using errcode = 'P0001';
      elsif new.due is not null then
        new.due_at := (new.due + time '17:00') at time zone v_tz;
      else
        new.due_at := staff_next_shift_end(new.owner_id);
        new.due := app_day(new.due_at);
      end if;
    end if;
    return new;
  end if;

  -- UPDATE: keep the date and the instant in step.
  if new.due_at is distinct from old.due_at then
    if new.due_at is not null and new.due is not distinct from old.due then
      new.due := app_day(new.due_at);
    end if;
  elsif new.due is distinct from old.due then
    -- Only the date moved (a caller that knows dates only).
    new.due_at := case when new.due is not null and v_timed then (new.due + time '17:00') at time zone v_tz end;
  elsif new.owner_id is distinct from old.owner_id and v_timed and new.due_at is null and new.due is not null then
    new.due_at := (new.due + time '17:00') at time zone v_tz;
  end if;

  -- An edit that leaves a timed-deadline task without a deadline. Status, group, done,
  -- soft delete, notes and priority are not "edits" here: the staff member progressing
  -- their own task, and the router adding a line to an old task, are never blocked.
  if v_timed and v_live and new.due_at is null
     and (old.due_at is not null
          or (new.owner_id, new.title, new.category, new.due, new.client_id, new.parent_task_id)
             is distinct from (old.owner_id, old.title, old.category, old.due, old.client_id, old.parent_task_id)) then
    if v_person then
      raise exception 'TASK_DEADLINE_REQUIRED: this person''s tasks need a deadline with a date and a time' using errcode = 'P0001';
    elsif new.owner_id is distinct from old.owner_id or old.due_at is not null then
      new.due_at := staff_next_shift_end(new.owner_id);
      new.due := app_day(new.due_at);
    end if;
  end if;

  -- A moved deadline: reminders still queued for the old one are closed, not sent late.
  -- (New ones are keyed on the new deadline, so they fire again.)
  if new.due_at is distinct from old.due_at then
    update notifications n set sent_at = now(), slack_ts = 'skipped:rescheduled', channel = 'skipped:rescheduled'
    where n.sent_at is null and n.record_type = 'tasks' and n.record_id = new.id
      and n.rule_key in ('task_due_2h', 'task_overdue', 'task_overdue_24h');
  end if;
  return new;
end $$;

create trigger tasks_rules_deadline before insert or update on tasks
  for each row execute function tasks_deadline();

-- ---------------------------------------------------------------------------
-- The task views. Old columns unchanged and in place; new ones appended.
--   due_at               the deadline instant, null for a date-only or undated task
--   is_overdue           open and past the deadline: to the minute with due_at, else the day rule
--   minutes_to_deadline  whole minutes until due_at (negative once overdue); null without due_at or when done
--   deadline_at          what lists sort on: due_at, else the end of the due day in ET
--   owner_timezone       the timezone the owner reads the deadline in
-- ---------------------------------------------------------------------------
create or replace view task_list with (security_invoker = true) as
select
  t.id, t.owner_id, t.parent_task_id,
  p.title as parent_title,
  t.title, t.client_id,
  c.name as client_name,
  t.category, t.priority,
  case t.priority when 'high' then 1 when 'medium' then 2 else 3 end as priority_rank,
  t.due,
  case when t.status <> 'done' and t.due < app_today() then app_today() - t.due end as days_overdue,
  t.status, t.task_group, t.source, t.notes,
  t.done_at,
  app_day(t.done_at) as done_day,
  case when t.task_group = 'done' then
    row_number() over (partition by t.owner_id, t.task_group order by t.done_at desc nulls last, t.updated_at desc, t.id)
  end as done_rank,
  t.created_at,
  t.due_at,
  (t.status <> 'done' and case when t.due_at is not null then now() > t.due_at else coalesce(t.due < app_today(), false) end) as is_overdue,
  case when t.due_at is not null and t.status <> 'done'
    then floor(extract(epoch from (t.due_at - now())) / 60.0)::integer end as minutes_to_deadline,
  coalesce(t.due_at, ((t.due + 1)::timestamp at time zone 'America/New_York')) as deadline_at,
  coalesce(nullif(btrim(o.timezone), ''), 'Europe/London') as owner_timezone
from tasks t
left join clients c on c.id = t.client_id
left join tasks p on p.id = t.parent_task_id and p.deleted_at is null
left join staff o on o.id = t.owner_id
where t.deleted_at is null;

create or replace view task_owners with (security_invoker = true) as
select
  s.id as owner_id, s.name, s.role,
  count(t.id) filter (where t.task_group <> 'done') as open_tasks,
  count(t.id) filter (where t.is_overdue) as overdue_tasks,
  count(t.id) filter (where t.task_group = 'done') as done_tasks,
  staff_has_timed_deadlines(s.role) as timed_deadlines,
  coalesce(nullif(btrim(s.timezone), ''), 'Europe/London') as timezone
from staff s
left join task_list t on t.owner_id = s.id
where s.status <> 'left'
group by s.id, s.name, s.role, s.timezone;

grant select on task_list, task_owners to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Reminders. reminder_candidates is the 0027 text with the task parts changed:
--   open_tasks carries due_at and created_at;
--   the day-based task_overdue is for tasks without a time only;
--   three new arms: task_due_2h, task_overdue at the deadline, task_overdue_24h;
--   task_assigned says the deadline time; owner_escalation leaves timed tasks to task_overdue_24h
--   (so the owner gets one DM about a late timed task, not two).
-- Every other arm is unchanged. reminders_enqueue and reminders_deliverable are not touched.
-- ---------------------------------------------------------------------------
insert into reminder_rules (key, enabled, audience, channel_or_dm, timing, template, urgent, quiet_hours_respected) values
  ('task_due_2h', true, 'task owner (tasks with a date and time deadline)', 'dm',
   '2 hours before the deadline, inside their shift (not held when no shift is entered); skipped when the task was created with under 2 hours to go',
   'Due in 2h', false, true),
  ('task_overdue_24h', true, 'owner', 'dm',
   'once, when a task with a date and time deadline is still open 24 hours after it',
   'Task still open a day after its deadline', false, true)
on conflict (key) do nothing;
update reminder_rules
set timing = 'tasks with a date and time deadline: once, the minute the deadline passes (inside their shift). Date-only tasks: shift start, daily while overdue'
where key = 'task_overdue';

create or replace function reminder_candidates(p_now timestamptz default now())
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
  select t.id, t.owner_id, t.title, t.due, t.priority, c.name as client_name, t.due_at, t.created_at
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
where ss.day_open and t.due_at is null

union all
-- Tasks with a date and time deadline (due_at). Both go to the task's owner and are held to
-- their shift like any staff reminder; someone with no shift entered is not held back (the
-- row is marked urgent, which is how the queue lets a no-shift person's message through).
-- The window key carries the deadline, so a changed deadline reminds again.
-- task_due_2h: two hours before. Skipped when the task was created with less than two hours
-- to go, and when the person is off shift until after the deadline (it would arrive late).
select 'task_due_2h', ss.staff_id, null, 'tasks', t.id, 'due:' || extract(epoch from t.due_at)::bigint, not ss.has_shift,
  jsonb_build_object('title', t.title, 'due', t.due, 'due_at', t.due_at, 'client', t.client_name, 'priority', t.priority,
    'tz', staff_tz(ss.staff_id))
from ss join open_tasks t on t.owner_id = ss.staff_id
where t.due_at > p_now and t.due_at <= p_now + interval '2 hours'
  and t.created_at <= t.due_at - interval '2 hours'
  and (ss.on_shift or not ss.has_shift or ss.next_start < t.due_at)
union all
-- task_overdue for a timed task: once, the minute the deadline passes (for a day afterwards,
-- so a deadline that passed long ago does not start reminding now).
select 'task_overdue', ss.staff_id, null, 'tasks', t.id, 'at:' || extract(epoch from t.due_at)::bigint, not ss.has_shift,
  jsonb_build_object('title', t.title, 'due', t.due, 'due_at', t.due_at, 'client', t.client_name, 'priority', t.priority,
    'tz', staff_tz(ss.staff_id))
from ss join open_tasks t on t.owner_id = ss.staff_id
where t.due_at <= p_now and t.due_at > p_now - interval '24 hours'
union all
-- task_overdue_24h: one DM to the owner when it is still open 24 hours after the deadline.
select 'task_overdue_24h', own.staff_id, null, 'tasks', t.id, 'at:' || extract(epoch from t.due_at)::bigint, false,
  jsonb_build_object('title', t.title, 'due_at', t.due_at, 'client', t.client_name, 'owner', s.name,
    'hours_overdue', floor(extract(epoch from (p_now - t.due_at)) / 3600.0), 'tz', 'Europe/London')
from open_tasks t
join staff s on s.id = t.owner_id and s.role <> 'owner'
cross join own
where t.due_at <= p_now - interval '24 hours' and t.due_at > p_now - interval '7 days'

union all
-- task_assigned: a task someone else put on this person's list in the last 24 hours.
-- "Someone else" = the actor on the task's audit_log _created row is not the owner.
-- A server-side insert (actor "system") counts unless the task is the person's own
-- (source staff) or Ryan's on his own list.
select 'task_assigned', t.owner_id, null, 'tasks', t.id, '', false,
  jsonb_build_object('title', t.title, 'due', t.due, 'due_at', t.due_at, 'tz', staff_tz(t.owner_id), 'client', c.name,
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
left join tasks t on r.esc_type = 'tasks' and t.id = r.esc_id and t.deleted_at is null and t.status <> 'done' and t.due_at is null
left join tech_jobs j on r.esc_type = 'tech_jobs' and j.id = r.esc_id and j.deleted_at is null and j.status <> 'done'
left join exceptions e on r.esc_type = 'exceptions' and e.id = r.esc_id and e.status = 'open'
where r.first_sent <= p_now - interval '24 hours'
  and (t.id is not null or j.id is not null or e.id is not null)
$$;

-- ---------------------------------------------------------------------------
-- Scorecard: tasks done on time, per timed-deadline person per ET week (Mon-Sun).
-- A task belongs to the week its deadline falls in. On time = marked done at or
-- before the deadline. Late = done after it, or still open past it. A task whose
-- deadline has not passed and is not done yet is not counted either way; a task
-- with no deadline, or soft-deleted, is never counted. Nothing to count = no data
-- (value and colour null), never 0% or 100%. Deadlines before go_live_date are
-- not scored, like the rest of the scorecard.
-- ---------------------------------------------------------------------------
insert into scoring_config (key, card, label, direction, green, amber, value, unit) values
  ('tasks_on_time_pct', 'tasks', 'Tasks done on time', 'higher_better', 90, 70, null, '%')
on conflict (key) do nothing;

create view score_tasks_weekly with (security_invoker = true) as
with weeks as (
  select g::date as week_start
  from generate_series(app_week_start(app_today()) - 84, app_week_start(app_today()), interval '7 day') g
),
people as (
  select s.id as staff_id, s.role
  from staff s
  where staff_has_timed_deadlines(s.role) and s.status <> 'left'
),
due as (
  select t.id, t.owner_id, app_week_start(app_day(t.due_at)) as week_start,
    coalesce(t.status = 'done' and t.done_at <= t.due_at, false) as on_time,
    (t.status = 'done' or t.due_at < now()) as decided
  from tasks t
  where t.deleted_at is null and t.due_at is not null
    and app_day(t.due_at) >= (select (value #>> '{}')::date from app_settings where key = 'go_live_date')
),
agg as (
  select p.staff_id, p.role, w.week_start,
    count(d.id) filter (where d.decided) as counted,
    count(d.id) filter (where d.decided and d.on_time) as on_time
  from people p
  cross join weeks w
  left join due d on d.owner_id = p.staff_id and d.week_start = w.week_start
  group by 1, 2, 3
)
select
  a.staff_id,
  a.week_start,
  a.role::text as card,
  'tasks_on_time_pct'::text as metric,
  case when a.counted > 0 then round(100.0 * a.on_time / a.counted, 1) end as value,
  a.on_time::numeric as numerator,
  a.counted::numeric as denominator,
  case when a.counted > 0 then score_colour('tasks_on_time_pct', round(100.0 * a.on_time / a.counted, 1)) end as colour
from agg a;

revoke all on score_tasks_weekly from anon;
grant select on score_tasks_weekly to authenticated, service_role;

-- The one scorecard view (0033), with the new metric. It takes the baseline flag and the
-- snapshot like every other metric.
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
  union all
  select staff_id, week_start, card, metric, value, numerator, denominator, colour from score_tasks_weekly
) s;

-- ---------------------------------------------------------------------------
-- Tech jobs: the owner can replace the automatic due time with a date and time.
--   due_override  the owner's deadline, or null for automatic
--   due_auto      the automatic due time, kept so "back to automatic" can restore it
--   due_at        always the one in force (everything that reads due_at needs no change)
-- This trigger runs after tech_jobs_defaults (name order), so an override survives the
-- SLA being recalculated when the type or the request time changes.
-- ---------------------------------------------------------------------------
alter table tech_jobs add column due_override timestamptz;
alter table tech_jobs add column due_auto timestamptz;

create function tech_jobs_due_override() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.due_override is not null and not app_is_privileged() then
      raise exception 'TECH_DEADLINE_OWNER_ONLY: only the owner can set a job''s deadline' using errcode = 'P0001';
    end if;
    new.due_auto := new.due_at;
  else
    if new.due_override is distinct from old.due_override and not app_is_privileged() then
      raise exception 'TECH_DEADLINE_OWNER_ONLY: only the owner can set a job''s deadline' using errcode = 'P0001';
    end if;
    -- new.due_at is the automatic time when there was no override, or when tech_jobs_defaults
    -- has just recalculated it; otherwise it still holds the old override.
    new.due_auto := case when old.due_override is null or new.due_at is distinct from old.due_at
      then new.due_at else old.due_auto end;
  end if;
  new.due_at := coalesce(new.due_override, new.due_auto);
  return new;
end $$;

create trigger tech_jobs_due_override before insert or update on tech_jobs
  for each row execute function tech_jobs_due_override();

-- tech_job_sla (0003): a job with an owner-set deadline has no SLA minutes, so it is overdue,
-- and met or missed, on its due time (the existing due_at rule, pauses included). Otherwise unchanged.
create or replace view tech_job_sla with (security_invoker = true) as
with j as (
  select t.*, coalesce(t.done_at, now()) as end_at
  from tech_jobs t
  where t.deleted_at is null
),
m as (
  select
    j.id as tech_job_id,
    j.type,
    j.end_at,
    -- An owner-set deadline replaces the SLA clock: the job is then judged against due_at.
    case when j.due_override is not null then null else case j.type
      when 'fix' then config_value('sla_fix_business_minutes')
      when 'launch' then config_value('sla_launch_hours') * 60
    end end as sla_minutes,
    case when j.type = 'fix'
      then business_minutes_between(j.requested_at, j.end_at)
      else extract(epoch from (j.end_at - j.requested_at)) / 60.0
    end as elapsed_minutes,
    coalesce((
      select sum(case when j.type = 'fix'
        then business_minutes_between(greatest(sp.paused_at, j.requested_at), least(coalesce(sp.resumed_at, j.end_at), j.end_at))
        else greatest(extract(epoch from (least(coalesce(sp.resumed_at, j.end_at), j.end_at) - greatest(sp.paused_at, j.requested_at))) / 60.0, 0)
      end)
      from sla_pauses sp where sp.tech_job_id = j.id
    ), 0) as paused_minutes,
    exists (select 1 from sla_pauses sp where sp.tech_job_id = j.id and sp.resumed_at is null) as is_paused,
    (select count(*) from sla_pauses sp where sp.tech_job_id = j.id) as pause_count,
    j.due_at,
    j.done_at
  from j
)
select
  tech_job_id,
  type,
  sla_minutes,
  elapsed_minutes,
  paused_minutes,
  greatest(elapsed_minutes - paused_minutes, 0) as genexa_minutes,
  is_paused,
  pause_count,
  case
    when sla_minutes is not null then greatest(elapsed_minutes - paused_minutes, 0) > sla_minutes
    when due_at is not null then end_at > due_at + (paused_minutes * interval '1 minute')
    else false
  end as is_overdue,
  case when done_at is null then null
    when sla_minutes is not null then greatest(elapsed_minutes - paused_minutes, 0) <= sla_minutes
    when due_at is not null then end_at <= due_at + (paused_minutes * interval '1 minute')
  end as met_sla
from m;

-- tech_jobs_board (0016) with the two new columns appended.
create or replace view tech_jobs_board with (security_invoker = true) as
select
  j.id as tech_job_id,
  j.type,
  j.title,
  j.notes,
  j.client_id,
  c.name as client_name,
  j.requested_by,
  rb.name as requested_by_name,
  j.owner_id,
  ow.name as owner_name,
  j.requested_at,
  j.due_at,
  j.done_at,
  j.status,
  j.blocked_on,
  j.broke_after_live,
  s.sla_minutes,
  s.genexa_minutes,
  s.paused_minutes,
  s.pause_count,
  s.is_paused,
  s.is_overdue,
  s.met_sla,
  p.id as open_pause_id,
  p.reason as pause_reason,
  p.evidence_note as pause_evidence,
  p.paused_at,
  (j.done_at is not null
    and app_week_start(app_day(j.done_at)) = app_week_start(app_today())) as done_this_week,
  j.due_override,
  j.due_auto
from tech_jobs j
join tech_job_sla s on s.tech_job_id = j.id
left join clients c on c.id = j.client_id
left join staff rb on rb.id = j.requested_by
left join staff ow on ow.id = j.owner_id
left join sla_pauses p on p.tech_job_id = j.id and p.resumed_at is null
where j.deleted_at is null;

-- ---------------------------------------------------------------------------
-- Request router: the work it creates carries a deadline.
--   assigned_due_at  the owner's own deadline for a request still waiting in Triage or for
--                    approval (the model's answer in due_at is never overwritten).
-- route_client_request is the 0035 text; only the tech job and task inserts changed.
-- ---------------------------------------------------------------------------
alter table client_requests add column assigned_due_at timestamptz;

create or replace function route_client_request(
  p_id uuid,
  p_is_request boolean default null,
  p_owner text default null,
  p_title text default null,
  p_due_at timestamptz default null,
  p_urgency text default null,
  p_confidence numeric default null,
  p_tech_type text default null,
  p_force_owner text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r client_requests;
  twin client_requests;
  v_client_name text;
  v_tz text;
  v_owner text;
  v_role text;
  v_staff uuid;
  v_title text;
  v_notes text;
  v_urgent boolean;
  v_type text;
  v_table text;
  v_item uuid;
  v_line text;
  v_reason text;
begin
  perform set_config('app.actor', 'request-router', true);
  select * into r from client_requests where id = p_id for update;
  if not found then
    raise exception 'ROUTER_NOT_FOUND: no such client request' using errcode = 'P0001';
  end if;

  if p_force_owner is null then
    -- Already decided (a second worker, or a Slack retry): change nothing.
    if r.status <> 'new' then return router_result(p_id); end if;
    if p_is_request is null then
      raise exception 'ROUTER_NO_ANSWER: a classification is required' using errcode = 'P0001';
    end if;

    update client_requests
    set is_request = p_is_request,
        owner = case when p_is_request then p_owner end,
        title = nullif(btrim(coalesce(p_title, '')), ''),
        due_at = case when p_is_request then p_due_at end,
        urgency = coalesce(p_urgency, 'normal'),
        confidence = p_confidence,
        tech_type = case when p_is_request and p_owner = 'tech' then coalesce(p_tech_type, 'other') end,
        classified_at = now(), classify_error = null, claimed_at = null
    where id = p_id
    returning * into r;

    if r.confidence is null or r.confidence < 0.8 then
      update client_requests set status = 'triage',
        triage_reason = 'Low confidence (' || coalesce(round(r.confidence * 100)::text || '%', 'none given') || ')'
      where id = p_id;
      return router_result(p_id);
    elsif not r.is_request then
      update client_requests set status = 'not_request' where id = p_id;
      return router_result(p_id);
    elsif r.owner is null then
      update client_requests set status = 'triage', triage_reason = 'A request with no clear owner' where id = p_id;
      return router_result(p_id);
    elsif r.mode = 'backfill' then
      -- Nothing from a backfill becomes work until a person approves it.
      update client_requests set status = 'pending_approval' where id = p_id;
      return router_result(p_id);
    end if;
    v_owner := r.owner;
  else
    if r.status not in ('triage', 'pending_approval') then
      raise exception 'ROUTER_STATE: only a Triage or awaiting-approval request can be assigned' using errcode = 'P0001';
    end if;
    if p_force_owner not in ('tech', 'ads', 'ryan') then
      raise exception 'ROUTER_OWNER: owner must be tech, ads or ryan' using errcode = 'P0001';
    end if;
    v_owner := p_force_owner;
    update client_requests set assigned_owner = v_owner, triage_reason = null where id = p_id returning * into r;
  end if;

  select c.name, coalesce(c.timezone, 'America/New_York') into v_client_name, v_tz from clients c where c.id = r.client_id;
  v_title := coalesce(r.title, nullif(left(btrim(regexp_replace(r.text, '\s+', ' ', 'g')), 80), ''), 'Client request');
  v_notes := r.text || E'\n' || r.permalink;
  v_urgent := coalesce(r.urgency, 'normal') = 'urgent';
  v_role := case v_owner when 'tech' then 'tech' when 'ads' then 'media_buyer' else 'owner' end;
  v_staff := app_role_holder(v_role);
  if v_staff is null then
    update client_requests set status = 'triage',
      triage_reason = 'No one on the team holds the ' || replace(v_role, '_', ' ') || ' role'
    where id = p_id;
    return router_result(p_id);
  end if;

  -- The same clinic asking for the same thing again within 7 days adds to the
  -- open item instead of making a second one.
  select o.* into twin
  from client_requests o
  where o.client_id = r.client_id and o.id <> r.id and o.status = 'routed'
    and coalesce(o.assigned_owner, o.owner) = v_owner
    and o.received_at > r.received_at - interval '7 days'
    and o.received_at < r.received_at + interval '7 days'
    and similarity(lower(o.title), lower(v_title)) >= 0.5
    and router_item_state(o.routed_table, o.routed_id) = 'open'
  order by similarity(lower(o.title), lower(v_title)) desc, o.received_at desc
  limit 1;

  if found then
    v_line := 'Also asked ' || to_char(r.received_at at time zone v_tz, 'Dy FMDD Mon') || ': ' || r.permalink;
    if twin.routed_table = 'tasks' then
      update tasks set notes = concat_ws(E'\n', notes, v_line) where id = twin.routed_id;
    elsif twin.routed_table = 'tech_jobs' then
      update tech_jobs set notes = concat_ws(E'\n', notes, v_line) where id = twin.routed_id;
    else
      update exceptions set notes = concat_ws(E'\n', notes, v_line) where id = twin.routed_id;
    end if;
    update client_requests
    set status = 'merged', merged_into = twin.id, routed_table = twin.routed_table, routed_id = twin.routed_id, title = v_title
    where id = p_id;
    return router_result(p_id);
  end if;

  begin
    if v_owner = 'tech' then
      v_type := coalesce(r.tech_type, 'other');
      v_table := 'tech_jobs';
      -- A fix gets its due time from the SLA (tech_jobs_defaults); anything else uses the deadline the
      -- client gave, or the end of the tech person's next shift. A deadline the owner set on the
      -- request beats both (due_override).
      insert into tech_jobs (client_id, type, title, notes, requested_at, due_at, due_override, owner_id, source_url)
      values (r.client_id, v_type, v_title, v_notes, r.received_at,
              case when v_type = 'other' then coalesce(r.due_at, staff_next_shift_end(v_staff)) end, r.assigned_due_at, v_staff, r.permalink)
      returning id into v_item;
    elsif v_owner = 'ads' then
      v_table := 'tasks';
      -- The deadline: the owner's choice, else the client's, else the end of the media buyer's next shift.
      insert into tasks (owner_id, title, client_id, category, source, priority, due, due_at, notes, source_url)
      values (v_staff, v_title, r.client_id, 'ads', 'slack', case when v_urgent then 'high' else 'medium' end,
              (coalesce(r.assigned_due_at, r.due_at, staff_next_shift_end(v_staff)) at time zone v_tz)::date,
              coalesce(r.assigned_due_at, r.due_at, staff_next_shift_end(v_staff)), v_notes, r.permalink)
      returning id into v_item;
    else
      v_table := 'exceptions';
      insert into exceptions (type, client_id, owner_id, severity, reason, record_table, record_id, dedupe_key, source_url, notes)
      values ('client_request', r.client_id, v_staff, case when v_urgent then 'red' else 'amber' end,
              v_client_name || ': ' || v_title, 'client_requests', r.id, 'client_request:' || r.id, r.permalink, v_notes)
      returning id into v_item;
      -- The owner's DM, queued like any exception DM. Urgent ones carry their own
      -- text and the urgent flag, so they go out at once instead of waiting for a shift.
      insert into notifications (rule_key, staff_id, record_type, record_id, payload)
      values ('exception_opened', v_staff, 'exceptions', v_item,
              case when v_urgent then jsonb_build_object(
                'reason', v_client_name || ': ' || v_title, 'severity', 'red', 'type', 'client_request', '_urgent', true) end)
      on conflict do nothing;
    end if;
  exception when sqlstate 'P0001' then
    v_reason := router_refusal_reason(sqlerrm);
    update client_requests set status = 'triage', triage_reason = v_reason where id = p_id;
    return router_result(p_id);
  end;

  update client_requests
  set status = 'routed', routed_table = v_table, routed_id = v_item, title = v_title,
      -- With replies switched off nothing is left waiting to be sent later.
      reply_logged_ts = case when r.mode = 'backfill' then 'skipped:backfill'
                             when not router_replies_enabled() then 'off' end
  where id = p_id;
  return router_result(p_id);
end $$;


-- The owner sets or clears (null) the deadline of a request that is not work yet.
create function router_set_deadline(p_id uuid, p_due_at timestamptz) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not app_is_owner() then
    raise exception 'ROUTER_OWNER_ONLY: only the owner can set a request''s deadline' using errcode = 'P0001';
  end if;
  update client_requests set assigned_due_at = p_due_at
  where id = p_id and status in ('triage', 'pending_approval');
  if not found then
    raise exception 'ROUTER_STATE: only a Triage or awaiting-approval request can be given a deadline' using errcode = 'P0001';
  end if;
end $$;
revoke execute on function router_set_deadline(uuid, timestamptz) from public, anon;
grant execute on function router_set_deadline(uuid, timestamptz) to authenticated, service_role;

-- The deadline each request has, or will get when it is assigned or approved.
--   source: item (the work already created), set (the owner's), message (the client's),
--           next_shift (end of that person's next shift), sla (a fix: 30 business minutes),
--           on_assign (no owner yet: end of the assignee's next shift), none.
create view client_request_deadlines with (security_invoker = true) as
with next_end as (
  select x.owner, case when h.staff_id is not null then staff_next_shift_end(h.staff_id) end as at
  from (values ('tech', 'tech'), ('ads', 'media_buyer')) x(owner, role)
  cross join lateral (select app_role_holder(x.role) as staff_id) h
),
q as (
  select r.*, coalesce(r.assigned_owner, r.owner) as eff_owner,
    (r.status in ('triage', 'pending_approval')) as waiting
  from client_requests r
)
select
  q.id as request_id,
  q.waiting as can_change,
  case
    when q.status in ('routed', 'merged') then case q.routed_table when 'tasks' then t.due_at when 'tech_jobs' then j.due_at end
    when not q.waiting then null
    when q.assigned_due_at is not null then q.assigned_due_at
    when q.eff_owner = 'tech' and q.tech_type = 'fix' then null
    when q.due_at is not null then q.due_at
    when q.eff_owner in ('tech', 'ads') then n.at
  end as deadline_at,
  case
    when q.status in ('routed', 'merged') then 'item'
    when not q.waiting then 'none'
    when q.assigned_due_at is not null then 'set'
    when q.eff_owner = 'tech' and q.tech_type = 'fix' then 'sla'
    when q.due_at is not null then 'message'
    when q.eff_owner in ('tech', 'ads') then 'next_shift'
    when q.eff_owner is null then 'on_assign'
    else 'none'
  end as source
from q
left join tasks t on q.routed_table = 'tasks' and t.id = q.routed_id
left join tech_jobs j on q.routed_table = 'tech_jobs' and j.id = q.routed_id
left join next_end n on n.owner = q.eff_owner;

revoke all on client_request_deadlines from anon;
grant select on client_request_deadlines to authenticated, service_role;
