-- EODs are only expected from the go-live date (app_settings.go_live_date).
-- Until it is set, nobody has an EOD score: the form did not exist, so a
-- missing EOD is not a miss.
create or replace view score_eods_weekly with (security_invoker = true) as
with weeks as (
  select g::date as week_start
  from generate_series(
    app_week_start(app_today()) - 84, app_week_start(app_today()), interval '7 day') g
),
people as (
  select s.id as staff_id, s.role as card, s.start_date,
    case s.role when 'csr' then 'csr_eods_missed' when 'tech' then 'tech_eods_missed' else 'media_eods_missed' end as config_key,
    (s.role = 'csr') as seven_day
  from staff s
  where s.role in ('csr', 'tech', 'media_buyer') and s.status <> 'left'
),
days as (
  select p.staff_id, w.week_start, d::date as day
  from people p
  cross join weeks w
  cross join lateral generate_series(w.week_start, w.week_start + 6, interval '1 day') d
  where (p.seven_day or extract(isodow from d) < 6)
    and (p.start_date is null or d::date >= p.start_date)
    -- Nobody is scored on EODs before the app's go-live date is set and reached.
    and d::date >= (select (value #>> '{}')::date from app_settings where key = 'go_live_date')
),
agg as (
  select
    dy.staff_id, dy.week_start,
    count(*) as expected,
    count(*) filter (where dy.day < app_today()) as due_so_far,
    count(e.id) as filed,
    count(e.id) filter (where dy.day < app_today()) as filed_of_due
  from days dy
  left join eods e on e.staff_id = dy.staff_id and e.date = dy.day
  group by 1, 2
)
select
  a.staff_id,
  a.week_start,
  p.card,
  'eods'::text as metric,
  a.filed::numeric as value,
  a.filed::numeric as numerator,
  a.expected::numeric as denominator,
  case when a.due_so_far = 0 then null
    else score_colour(p.config_key, (a.due_so_far - a.filed_of_due)::numeric) end as colour
from agg a
join people p on p.staff_id = a.staff_id;
