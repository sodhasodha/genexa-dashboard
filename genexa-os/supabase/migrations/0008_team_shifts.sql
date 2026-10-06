-- Phase 1b: shift rota and coverage.
-- A shift is start/end in the person's own timezone on their working days
-- (ISO weekday numbers, 1 = Monday). An end at or before the start runs overnight.
alter table staff add column working_days smallint[] not null default '{1,2,3,4,5}';
alter table staff add constraint staff_working_days_valid check (working_days <@ array[1,2,3,4,5,6,7]::smallint[]);

insert into scoring_config (key, card, label, direction, green, amber, value, unit) values
  ('coverage_start_hour_et', 'team', 'CSR cover expected from (ET hour)', 'constant', null, null, 8,  'hour'),
  ('coverage_end_hour_et',   'team', 'CSR cover expected until (ET hour)', 'constant', null, null, 22, 'hour')
on conflict (key) do nothing;

-- Each person's shifts for the current ET week, as real instants.
create view staff_shifts_week with (security_invoker = true) as
select
  s.id as staff_id, s.name, s.role, s.pod,
  d.day::date as local_day,
  ((d.day::date + s.shift_start) at time zone s.timezone) as starts_at,
  ((d.day::date + s.shift_end) at time zone s.timezone)
    + case when s.shift_end <= s.shift_start then interval '1 day' else interval '0' end as ends_at
from staff s
cross join lateral generate_series(
  app_week_start(app_today()) - 1, app_week_start(app_today()) + 7, interval '1 day') as d(day)
where s.status <> 'left'
  and s.shift_start is not null and s.shift_end is not null
  and extract(isodow from d.day)::smallint = any (s.working_days);

-- Who is on, for every ET hour of the current week (Mon-Sun).
create view team_coverage_hourly with (security_invoker = true) as
with slots as (
  select h as slot_start, h + interval '1 hour' as slot_end
  from generate_series(
    (app_week_start(app_today())::timestamp at time zone 'America/New_York'),
    ((app_week_start(app_today()) + 7)::timestamp at time zone 'America/New_York') - interval '1 hour',
    interval '1 hour') h
)
select
  app_day(sl.slot_start) as day,
  extract(isodow from (sl.slot_start at time zone 'America/New_York'))::int as isodow,
  extract(hour from (sl.slot_start at time zone 'America/New_York'))::int as et_hour,
  sh.staff_id, sh.name, sh.role, sh.pod
from slots sl
join staff_shifts_week sh on sh.starts_at < sl.slot_end and sh.ends_at > sl.slot_start;

-- Per ET hour: how many of each role are on, and whether CSR cover is missing
-- inside the hours it is expected.
create view team_coverage_summary with (security_invoker = true) as
with hours as (
  select d.isodow, h.et_hour
  from generate_series(1, 7) as d(isodow) cross join generate_series(0, 23) as h(et_hour)
),
c as (
  select isodow, et_hour,
    count(*) filter (where role = 'csr') as csrs_on,
    count(*) filter (where role = 'csr' and pod = 'pod_1') as pod_1_on,
    count(*) filter (where role = 'csr' and pod = 'pod_2') as pod_2_on,
    count(*) filter (where role = 'csr' and pod = 'pod_3') as pod_3_on,
    count(*) filter (where role = 'tech') as tech_on,
    count(*) filter (where role = 'media_buyer') as media_on,
    string_agg(name, ', ' order by role, name) as who
  from team_coverage_hourly group by 1, 2
)
select
  h.isodow, h.et_hour,
  coalesce(c.csrs_on, 0) as csrs_on,
  coalesce(c.pod_1_on, 0) as pod_1_on,
  coalesce(c.pod_2_on, 0) as pod_2_on,
  coalesce(c.pod_3_on, 0) as pod_3_on,
  coalesce(c.tech_on, 0) as tech_on,
  coalesce(c.media_on, 0) as media_on,
  c.who,
  (h.et_hour >= config_value('coverage_start_hour_et') and h.et_hour < config_value('coverage_end_hour_et')) as cover_expected,
  (h.et_hour >= config_value('coverage_start_hour_et') and h.et_hour < config_value('coverage_end_hour_et')
    and coalesce(c.csrs_on, 0) = 0) as csr_gap
from hours h
left join c on c.isodow = h.isodow and c.et_hour = h.et_hour;

-- An unknown timezone would break every coverage query, so it is refused at the door.
create function staff_timezone_valid() returns trigger
language plpgsql as $$
begin
  perform now() at time zone new.timezone;
  return new;
exception when others then
  raise exception 'STAFF_TIMEZONE: "%" is not a timezone name (use e.g. Asia/Manila)', new.timezone using errcode = 'P0001';
end $$;

create trigger staff_timezone_valid before insert or update of timezone on staff
  for each row execute function staff_timezone_valid();
