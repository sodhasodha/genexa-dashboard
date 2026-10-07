-- Attendance: clock in / out, status (on time, late, no-show, excused), alerts,
-- weekly numbers and the scorecard metrics. Builds on 0024 (shift_overrides,
-- attendance, shifts_resolved).
--
-- Rules, all read from scoring_config:
--   on time  = clocked in no later than attendance_late_minutes after shift start
--   late     = clocked in after that, or no clock-in once those minutes have passed
--   no-show  = no clock-in attendance_no_show_minutes after shift start. A later
--              clock-in is recorded but the status stays no-show until the owner changes it.
--   excused  = rostered but released for the day by an override (sick, holiday…)
-- A row the owner has edited by hand (manual = true) is never changed by the tick.

alter table attendance add column manual boolean not null default false;

-- Shifts that started before this instant are not tracked: without it the first
-- run would write a no-show for every shift of the last 35 days.
insert into app_settings (key, value) values ('attendance_tracking_start', to_jsonb(now()))
on conflict (key) do nothing;

insert into scoring_config (key, card, label, direction, green, amber, value, unit) values
  ('attendance_week_flag_lates', 'attendance', 'Morning digest: flag a person at this many lates in a week', 'constant', null, null, 3, 'lates')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- The status rule, in one place.
-- p_old is the status already on the row for the same shift (null if none).
-- ---------------------------------------------------------------------------
create function attendance_status(p_start timestamptz, p_clock_in timestamptz, p_now timestamptz, p_old text) returns text
language sql stable set search_path = public as $$
  select case
    when p_start is null then p_old
    when p_old = 'no_show' then 'no_show'
    when extract(epoch from (coalesce(p_clock_in, p_now) - p_start)) >= config_value('attendance_no_show_minutes') * 60 then 'no_show'
    when extract(epoch from (coalesce(p_clock_in, p_now) - p_start)) > config_value('attendance_late_minutes') * 60 then 'late'
    when p_clock_in is not null then 'on_time'
  end
$$;

-- Whole minutes after shift start. Null until there is a clock-in to measure.
create function attendance_minutes_late(p_start timestamptz, p_clock_in timestamptz, p_status text) returns integer
language sql immutable as $$
  select case
    when p_start is null or p_clock_in is null or p_status is null or p_status = 'excused' then null
    when p_status = 'on_time' then 0
    else greatest(floor(extract(epoch from (p_clock_in - p_start)) / 60)::int, 0)
  end
$$;

-- The shift a clock-in at p_now belongs to:
--   1. a working shift that is running, or starts within 2 hours (covers overnight
--      shifts and a shift that starts just after the person's local midnight);
--   2. otherwise whatever the roster says for the person's local date;
--   3. otherwise that local date with no shift.
create function attendance_target(p_staff uuid, p_now timestamptz)
returns table (day date, starts_at timestamptz, ends_at timestamptz, is_working boolean, excused boolean, timezone text)
language sql stable security definer set search_path = public as $$
  with me as (
    select s.id, s.timezone, (p_now at time zone s.timezone)::date as today from staff s where s.id = p_staff
  ),
  cand as (
    select sr.date, sr.starts_at, sr.ends_at, sr.is_working, sr.excused, 1 as pri, (sr.starts_at <= p_now) as started
    from shifts_resolved sr
    where sr.staff_id = p_staff and sr.is_working
      and p_now >= sr.starts_at - interval '2 hours' and p_now < sr.ends_at
    union all
    select sr.date, sr.starts_at, sr.ends_at, sr.is_working, sr.excused, 2, false
    from shifts_resolved sr join me on sr.date = me.today
    where sr.staff_id = p_staff
    union all
    select me.today, null, null, false, false, 3, false from me
  )
  select c.date, c.starts_at, c.ends_at, c.is_working, c.excused, me.timezone
  from cand c cross join me
  order by c.pri, c.started desc, c.starts_at desc
  limit 1
$$;

-- ---------------------------------------------------------------------------
-- Clock in / out. The inner functions take the instant so tests can move the
-- clock; only the wrappers are callable by people, and they always pass now().
-- ---------------------------------------------------------------------------
create function attendance_clock_in(p_staff uuid, p_now timestamptz) returns attendance
language plpgsql security definer set search_path = public as $$
declare
  t record;
  a attendance;
  v_start timestamptz;
  v_end timestamptz;
  v_status text;
begin
  if p_staff is null then
    raise exception 'ATTENDANCE_NOT_STAFF: only a logged-in staff member can clock in' using errcode = 'P0001';
  end if;
  select * into t from attendance_target(p_staff, p_now);
  if t.day is null then
    raise exception 'ATTENDANCE_NOT_STAFF: staff member not found' using errcode = 'P0001';
  end if;
  select * into a from attendance where staff_id = p_staff and date = t.day for update;
  if a.clock_in is not null then
    raise exception 'ATTENDANCE_ALREADY_IN: already clocked in for % at %', to_char(t.day, 'Dy DD Mon'),
      to_char(a.clock_in at time zone t.timezone, 'HH24:MI') using errcode = 'P0001';
  end if;
  if a.id is not null and a.manual then
    -- The owner has ruled on this day: record the time, leave the ruling alone.
    update attendance set clock_in = p_now where id = a.id returning * into a;
    return a;
  end if;

  v_start := case when t.is_working then t.starts_at end;
  v_end := case when t.is_working then t.ends_at end;
  v_status := case when t.excused then 'excused'
    else attendance_status(v_start, p_now, p_now, case when a.shift_start is not distinct from v_start then a.status end) end;

  insert into attendance (staff_id, date, shift_start, shift_end, clock_in, status, minutes_late)
  values (p_staff, t.day, v_start, v_end, p_now, v_status, attendance_minutes_late(v_start, p_now, v_status))
  on conflict (staff_id, date) do update
    set shift_start = excluded.shift_start, shift_end = excluded.shift_end, clock_in = excluded.clock_in,
        status = excluded.status, minutes_late = excluded.minutes_late
  returning * into a;
  return a;
end $$;

-- Closes the person's most recent open clock-in.
create function attendance_clock_out(p_staff uuid, p_now timestamptz) returns attendance
language plpgsql security definer set search_path = public as $$
declare
  a attendance;
begin
  if p_staff is null then
    raise exception 'ATTENDANCE_NOT_STAFF: only a logged-in staff member can clock out' using errcode = 'P0001';
  end if;
  select * into a from attendance
  where staff_id = p_staff and clock_in is not null and clock_out is null
  order by clock_in desc limit 1 for update;
  if a.id is null then
    raise exception 'ATTENDANCE_NOT_IN: not clocked in' using errcode = 'P0001';
  end if;
  update attendance set clock_out = p_now where id = a.id returning * into a;
  return a;
end $$;

create function clock_in() returns attendance
language sql security definer set search_path = public as $$
  select * from attendance_clock_in(app_staff_id(), now())
$$;

create function clock_out() returns attendance
language sql security definer set search_path = public as $$
  select * from attendance_clock_out(app_staff_id(), now())
$$;

-- ---------------------------------------------------------------------------
-- The tick: run every 5 minutes. Creates the row for every working shift that
-- has started and every excused day that has arrived, keeps shift times in step
-- with the roster, and sets status. Returns the rows whose status changed.
-- ---------------------------------------------------------------------------
create function attendance_tick(p_now timestamptz default now())
returns table (attendance_id uuid, staff_id uuid, old_status text, new_status text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  r record;
  v_from timestamptz;
  v_start timestamptz;
  v_end timestamptz;
  v_status text;
  v_min integer;
  v_id uuid;
begin
  select (value #>> '{}')::timestamptz into v_from from app_settings where key = 'attendance_tracking_start';
  v_from := coalesce(v_from, '-infinity');

  for r in
    select sr.staff_id as sid, sr.date as d, sr.excused, sr.starts_at, sr.ends_at,
      a.id as aid, a.status as a_status, a.clock_in as a_in, a.shift_start as a_start, a.shift_end as a_end,
      a.minutes_late as a_min, coalesce(a.manual, false) as a_manual
    from shifts_resolved sr
    left join attendance a on a.staff_id = sr.staff_id and a.date = sr.date
    where (sr.is_working and sr.starts_at <= p_now and sr.starts_at >= v_from)
       or (sr.excused and sr.date <= (p_now at time zone sr.timezone)::date
           and (v_from = '-infinity' or sr.date >= (v_from at time zone sr.timezone)::date))
    order by sr.starts_at nulls last, sr.staff_id
  loop
    continue when r.a_manual;
    if r.excused then
      v_start := null; v_end := null; v_status := 'excused';
    else
      v_start := r.starts_at; v_end := r.ends_at;
      -- A status only carries over while the shift itself is unchanged: after a
      -- swap the day is judged afresh against the new hours.
      v_status := attendance_status(v_start, r.a_in, p_now, case when r.a_start is not distinct from v_start then r.a_status end);
    end if;
    v_min := attendance_minutes_late(v_start, r.a_in, v_status);

    if r.aid is null then
      v_id := null;
      insert into attendance (staff_id, date, shift_start, shift_end, status, minutes_late)
      values (r.sid, r.d, v_start, v_end, v_status, v_min)
      on conflict (staff_id, date) do nothing
      returning id into v_id;
      continue when v_id is null; -- a clock-in landed first; the next run reads it
    else
      v_id := r.aid;
      if (v_start, v_end, v_status, v_min) is distinct from (r.a_start, r.a_end, r.a_status, r.a_min) then
        update attendance a set shift_start = v_start, shift_end = v_end, status = v_status, minutes_late = v_min
        where a.id = r.aid;
      end if;
    end if;

    if r.a_status is distinct from v_status then
      attendance_id := v_id; staff_id := r.sid; old_status := r.a_status; new_status := v_status;
      return next;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Owner edits a row by hand. A note is required; the row is then left alone by
-- the tick. Times are given in the person's own timezone.
-- ---------------------------------------------------------------------------
create function attendance_owner_edit(
  p_id uuid, p_status text, p_clock_in timestamp, p_clock_out timestamp, p_overtime_approved boolean, p_note text
) returns attendance
language plpgsql set search_path = public as $$
declare
  a attendance;
  v_tz text;
  v_in timestamptz;
  v_out timestamptz;
begin
  if not app_is_owner() then
    raise exception 'ATTENDANCE_OWNER_ONLY: only the owner edits attendance' using errcode = 'P0001';
  end if;
  if btrim(coalesce(p_note, '')) = '' then
    raise exception 'ATTENDANCE_NOTE_REQUIRED: an edit needs a note' using errcode = 'P0001';
  end if;
  select s.timezone into v_tz from attendance x join staff s on s.id = x.staff_id where x.id = p_id;
  if v_tz is null then
    raise exception 'ATTENDANCE_NOT_FOUND: no such attendance row' using errcode = 'P0001';
  end if;
  v_in := p_clock_in at time zone v_tz;
  v_out := p_clock_out at time zone v_tz;
  if v_in is not null and v_out is not null and v_out < v_in then
    raise exception 'ATTENDANCE_TIMES: clock out is before clock in' using errcode = 'P0001';
  end if;
  update attendance x
  set status = nullif(p_status, ''), clock_in = v_in, clock_out = v_out,
      overtime_approved = coalesce(p_overtime_approved, false), note = btrim(p_note),
      manual = true, approved_by = app_staff_id(),
      minutes_late = attendance_minutes_late(x.shift_start, v_in, nullif(p_status, ''))
  where x.id = p_id
  returning * into a;
  return a;
end $$;

-- ---------------------------------------------------------------------------
-- What the clock control at the top of every page shows for the caller.
-- No row = not a staff member. `show` is false when there is nothing to show.
--   state: not_clocked_in | clocked_in | clocked_out
-- ---------------------------------------------------------------------------
create function my_attendance()
returns table (
  staff_id uuid, timezone text, day date, rostered boolean, excused boolean, shift_label text,
  state text, status text, minutes_late integer, clock_in_label text, clock_out_label text, show boolean)
language sql stable security definer set search_path = public as $$
  with t as (
    select app_staff_id() as sid, x.* from attendance_target(app_staff_id(), now()) x
  ),
  today as (
    select a.* from attendance a join t on a.staff_id = t.sid and a.date = t.day
  ),
  open_row as (
    select a.* from attendance a join t on a.staff_id = t.sid
    where a.clock_in is not null and a.clock_out is null
    order by a.clock_in desc limit 1
  ),
  -- Today's row once it has a clock-in; otherwise an earlier clock-in still open.
  shown as (
    select * from today where clock_in is not null
    union all
    select * from open_row where not exists (select 1 from today where clock_in is not null)
    limit 1
  )
  select
    t.sid, t.timezone, t.day, t.is_working, t.excused,
    case when t.is_working then
      to_char(t.starts_at at time zone t.timezone, 'HH24:MI') || '–' || to_char(t.ends_at at time zone t.timezone, 'HH24:MI') end,
    case when s.id is null then 'not_clocked_in' when s.clock_out is null then 'clocked_in' else 'clocked_out' end,
    coalesce(s.status, (select status from today)),
    s.minutes_late,
    case when s.date <> t.day then to_char(s.date, 'Dy DD Mon ') else '' end || to_char(s.clock_in at time zone t.timezone, 'HH24:MI'),
    to_char(s.clock_out at time zone t.timezone, 'HH24:MI'),
    (t.is_working or s.id is not null)
  from t
  left join shown s on true
  where t.sid is not null
$$;

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------

-- Everyone on the roster for their own local today, with where they stand.
--   state: excused | on_time | late | no_show | off (override, not working)
--          | not_started | due (started, still inside the grace minutes)
create view attendance_today with (security_invoker = true) as
select
  sr.staff_id, sr.name, sr.role, sr.pod, sr.timezone, sr.date,
  sr.is_working, sr.excused, sr.override_kind, sr.override_note,
  case when sr.is_working then
    to_char(sr.starts_at at time zone sr.timezone, 'HH24:MI') || '–' || to_char(sr.ends_at at time zone sr.timezone, 'HH24:MI') end as shift_label,
  a.id as attendance_id, a.status, a.minutes_late, a.manual,
  to_char(a.clock_in at time zone sr.timezone, 'HH24:MI') as clock_in_label,
  to_char(a.clock_out at time zone sr.timezone, 'HH24:MI') as clock_out_label,
  case
    when a.status is not null then a.status
    when sr.excused then 'excused'
    when not sr.is_working then 'off'
    when now() < sr.starts_at then 'not_started'
    else 'due'
  end as state
from shifts_resolved sr
left join attendance a on a.staff_id = sr.staff_id and a.date = sr.date
where sr.date = (now() at time zone sr.timezone)::date;

-- Every attendance row with the person and times in their own timezone
-- (the *_local columns feed the owner's edit form).
create view attendance_log with (security_invoker = true) as
select
  a.id, a.staff_id, s.name, s.role, s.timezone, a.date, a.status, a.minutes_late, a.manual, a.overtime_approved, a.note,
  ap.name as approved_by_name,
  case when a.shift_start is not null then
    to_char(a.shift_start at time zone s.timezone, 'HH24:MI') || '–' || to_char(a.shift_end at time zone s.timezone, 'HH24:MI') end as shift_label,
  to_char(a.clock_in at time zone s.timezone, 'HH24:MI') as clock_in_label,
  to_char(a.clock_out at time zone s.timezone, 'HH24:MI') as clock_out_label,
  to_char(a.clock_in at time zone s.timezone, 'YYYY-MM-DD"T"HH24:MI') as clock_in_local,
  to_char(a.clock_out at time zone s.timezone, 'YYYY-MM-DD"T"HH24:MI') as clock_out_local
from attendance a
join staff s on s.id = a.staff_id
left join staff ap on ap.id = a.approved_by;

-- Per person per ET week (Mon-Sun, by the shift's start; an excused day by its date).
--   rostered    = shifts that have started and been decided (on time, late or no-show).
--                 Excused days are left out, and so is a shift still inside its grace minutes.
--   on_time_pct = on_time / rostered, 0-100. Null when rostered = 0.
create view attendance_weekly with (security_invoker = true) as
with rows as (
  select a.staff_id, a.status,
    app_week_start(coalesce(app_day(a.shift_start), a.date)) as week_start
  from attendance a
  where a.status = 'excused'
     or (a.shift_start is not null and a.shift_start <= now() and a.status in ('on_time', 'late', 'no_show'))
),
agg as (
  select staff_id, week_start,
    count(*) filter (where status <> 'excused') as rostered,
    count(*) filter (where status = 'on_time') as on_time,
    count(*) filter (where status = 'late') as late,
    count(*) filter (where status = 'no_show') as no_show,
    count(*) filter (where status = 'excused') as excused
  from rows group by 1, 2
)
select staff_id, week_start, rostered, on_time, late, no_show, excused,
  case when rostered > 0 then round(100.0 * on_time / rostered, 1) end as on_time_pct
from agg;

-- For the owner's morning digest: 3+ lates, or any no-show, in the current ET week.
create view attendance_week_flags with (security_invoker = true) as
select w.staff_id, s.name, w.week_start, w.late as late_count, w.no_show as no_show_count
from attendance_weekly w
join staff s on s.id = w.staff_id
where w.week_start = app_week_start(app_today())
  and (w.late >= config_value('attendance_week_flag_lates') or w.no_show > 0);

-- Scorecard metrics, same shape as the other score_*_weekly views.
--   attendance_pct  on-time shifts / rostered shifts. Red on any no-show that week,
--                   otherwise coloured from scoring_config.attendance_on_time_pct.
--                   Not coloured for weeks before go_live_date (tracked, not scored).
--   late_count, no_shows  counts, shown not scored.
-- Nothing rostered = value null, colour null.
create view score_attendance_weekly with (security_invoker = true) as
with weeks as (
  select g::date as week_start
  from generate_series(app_week_start(app_today()) - 84, app_week_start(app_today()), interval '7 day') g
),
people as (
  select s.id as staff_id, s.role
  from staff s
  where s.role in ('csr', 'tech', 'media_buyer') and s.status <> 'left'
),
base as (
  select p.staff_id, p.role, w.week_start,
    coalesce(a.rostered, 0) as rostered, coalesce(a.on_time, 0) as on_time,
    coalesce(a.late, 0) as late, coalesce(a.no_show, 0) as no_show, a.on_time_pct,
    coalesce(w.week_start >= (select (value #>> '{}')::date from app_settings where key = 'go_live_date'), false) as scored
  from people p
  cross join weeks w
  left join attendance_weekly a on a.staff_id = p.staff_id and a.week_start = w.week_start
)
select
  b.staff_id,
  b.week_start,
  b.role::text as card,
  m.metric,
  m.value::numeric as value,
  m.numerator::numeric as numerator,
  m.denominator::numeric as denominator,
  m.colour
from base b
cross join lateral (values
  ('attendance_pct'::text, b.on_time_pct, b.on_time, b.rostered,
    case
      when not b.scored or b.on_time_pct is null then null
      when b.no_show > 0 then 'red'
      else score_colour('attendance_on_time_pct', b.on_time_pct)
    end),
  ('late_count', case when b.rostered > 0 then b.late end, b.late, b.rostered, null),
  ('no_shows', case when b.rostered > 0 then b.no_show end, b.no_show, b.rostered, null)
) as m(metric, value, numerator, denominator, colour);

-- Alerts still to send: one row per (attendance row, recipient).
--   late    -> the person
--   no-show -> the media buyer and the owner (never the person themselves)
-- Only shifts from the last 24 hours, never a row the owner edited, and never
-- one already recorded in notifications.
create view attendance_alerts_due with (security_invoker = true) as
with a as (
  select at.id as attendance_id, at.staff_id, at.status, at.minutes_late, at.clock_in is not null as clocked_in,
    split_part(s.name, ' ', 1) as first_name,
    to_char(at.shift_start at time zone s.timezone, 'HH24:MI') as shift_start_label,
    at.shift_start
  from attendance at
  join staff s on s.id = at.staff_id
  where not at.manual and at.status in ('late', 'no_show')
    and at.shift_start is not null and at.shift_start >= now() - interval '24 hours'
),
t as (
  select a.*, 'attendance_late'::text as rule_key, a.staff_id as recipient_id from a where a.status = 'late'
  union all
  select a.*, 'attendance_no_show', r.id
  from a
  cross join lateral (select app_role_holder('media_buyer') as id union select app_role_holder('owner')) r
  where a.status = 'no_show' and r.id is not null and r.id <> a.staff_id
)
select t.attendance_id, t.staff_id, t.first_name, t.status, t.minutes_late, t.clocked_in, t.shift_start_label,
  t.rule_key, t.recipient_id, rs.slack_user_id as recipient_slack_id, rs.email as recipient_email,
  config_value('attendance_late_minutes')::int as late_minutes,
  config_value('attendance_no_show_minutes')::int as no_show_minutes
from t
join staff rs on rs.id = t.recipient_id
where not exists (
  select 1 from notifications n
  where n.rule_key = t.rule_key and n.staff_id = t.recipient_id and n.record_id = t.attendance_id and n.window_key = '')
order by t.shift_start, t.rule_key;

-- ---------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------
revoke execute on function attendance_target(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function attendance_clock_in(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function attendance_clock_out(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function attendance_tick(timestamptz) from public, anon, authenticated;
revoke execute on function clock_in() from public, anon;
revoke execute on function clock_out() from public, anon;
revoke execute on function my_attendance() from public, anon;
revoke execute on function attendance_owner_edit(uuid, text, timestamp, timestamp, boolean, text) from public, anon;
grant execute on function clock_in(), clock_out(), my_attendance(),
  attendance_owner_edit(uuid, text, timestamp, timestamp, boolean, text) to authenticated;
grant execute on function attendance_target(uuid, timestamptz), attendance_clock_in(uuid, timestamptz),
  attendance_clock_out(uuid, timestamptz), attendance_tick(timestamptz), clock_in(), clock_out() to service_role;

grant select on attendance_today, attendance_log, attendance_weekly, attendance_week_flags,
  score_attendance_weekly, attendance_alerts_due to authenticated, service_role;
revoke all on attendance_today, attendance_log, attendance_weekly, attendance_week_flags,
  score_attendance_weekly, attendance_alerts_due from anon;
