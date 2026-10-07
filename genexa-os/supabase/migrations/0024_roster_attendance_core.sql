-- Roster and attendance: the shared tables. Behaviour (clock in/out, status,
-- alerts, pay) is added on top by later migrations.

-- A one-day change to someone's normal shift.
--   sick / holiday: not working that day, excused.
--   swap / custom:  working different hours that day (both times set), or not working (both null).
create table shift_overrides (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id),
  date date not null,
  kind text not null check (kind in ('sick', 'holiday', 'swap', 'custom')),
  shift_start time,
  shift_end time,
  note text,
  created_by uuid references staff(id),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((shift_start is null) = (shift_end is null)),
  check (kind not in ('sick', 'holiday') or shift_start is null)
);
create unique index shift_overrides_one_per_day on shift_overrides (staff_id, date) where deleted_at is null;

-- One row per person per rostered day. `date` is the person's own calendar day
-- (their timezone), the same day their shift is defined on.
create table attendance (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id),
  date date not null,
  shift_start timestamptz,
  shift_end timestamptz,
  clock_in timestamptz,
  clock_out timestamptz,
  -- null until it can be decided (before the shift, or inside the grace window).
  status text check (status in ('on_time', 'late', 'no_show', 'excused')),
  minutes_late integer,
  overtime_approved boolean not null default false,
  note text,
  approved_by uuid references staff(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (staff_id, date),
  check (clock_out is null or clock_in is null or clock_out >= clock_in)
);
create index attendance_date_idx on attendance (date);

do $$
declare t text;
begin
  foreach t in array array['shift_overrides', 'attendance'] loop
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', t || '_set_updated_at', t);
    execute format('create trigger %I before delete on %I for each row execute function forbid_delete()', t || '_forbid_delete', t);
    execute format('create trigger %I after insert or update on %I for each row execute function audit_row()', t || '_audit', t);
    execute format('alter table %I enable row level security', t);
    execute format('create policy owner_all on %I for all to authenticated using (app_is_owner()) with check (app_is_owner())', t);
    execute format('create policy staff_read on %I for select to authenticated using (app_staff_id() is not null)', t);
  end loop;
end $$;

-- The roster after overrides: who is due to work, and when, for each day from
-- 35 days back to 14 days ahead. One row per person per day they are rostered
-- OR have an override.
create view shifts_resolved with (security_invoker = true) as
with days as (
  select s.id as staff_id, s.name, s.role, s.pod, s.timezone, s.shift_start, s.shift_end, s.working_days, s.start_date,
    d.day::date as date
  from staff s
  cross join lateral generate_series(
    (now() at time zone s.timezone)::date - 35, (now() at time zone s.timezone)::date + 14, interval '1 day') as d(day)
  where s.status <> 'left'
),
r as (
  select d.*, o.id as override_id, o.kind as override_kind, o.shift_start as o_start, o.shift_end as o_end, o.note as override_note,
    (d.shift_start is not null and d.shift_end is not null
      and extract(isodow from d.date)::smallint = any (d.working_days)
      and (d.start_date is null or d.date >= d.start_date)) as on_roster
  from days d
  left join shift_overrides o on o.staff_id = d.staff_id and o.date = d.date and o.deleted_at is null
),
x as (
  select r.*,
    case when r.override_id is not null then r.o_start else case when r.on_roster then r.shift_start end end as eff_start,
    case when r.override_id is not null then r.o_end else case when r.on_roster then r.shift_end end end as eff_end
  from r
  where r.on_roster or r.override_id is not null
)
select
  x.staff_id, x.name, x.role, x.pod, x.timezone, x.date,
  (x.eff_start is not null) as is_working,
  case when x.eff_start is not null then (x.date + x.eff_start) at time zone x.timezone end as starts_at,
  case when x.eff_start is not null then
    ((x.date + x.eff_end) at time zone x.timezone) + case when x.eff_end <= x.eff_start then interval '1 day' else interval '0' end
  end as ends_at,
  case when x.eff_start is not null then
    (extract(epoch from (
      ((x.date + x.eff_end) at time zone x.timezone) + case when x.eff_end <= x.eff_start then interval '1 day' else interval '0' end
      - ((x.date + x.eff_start) at time zone x.timezone))) / 60)::int
  end as rostered_minutes,
  x.override_kind,
  x.override_note,
  -- Rostered to work but released for the day: counts as excused, never as a no-show.
  (x.on_roster and x.override_id is not null and x.eff_start is null) as excused
from x;

insert into scoring_config (key, card, label, direction, green, amber, value, unit) values
  ('attendance_late_minutes',    'attendance', 'Late: no clock-in this many minutes after shift start',    'constant', null, null, 10, 'min'),
  ('attendance_no_show_minutes', 'attendance', 'No-show: no clock-in this many minutes after shift start', 'constant', null, null, 30, 'min'),
  ('attendance_on_time_pct',     'attendance', 'On-time shifts',                                           'higher_better', 95, 85, null, '%')
on conflict (key) do nothing;

-- Attendance and EODs are tracked from now and scored from Monday 12 October 2026.
update app_settings set value = '"2026-10-12"' where key = 'go_live_date';
