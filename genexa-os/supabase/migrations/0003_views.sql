-- Genexa OS: derived views. Sync jobs never write these.
-- Every view is security_invoker so RLS on the underlying tables applies.

-- ---------------------------------------------------------------------------
-- Source freshness. Stale = last success older than 2x the schedule.
-- ---------------------------------------------------------------------------
create view source_freshness with (security_invoker = true) as
select
  s.source,
  s.schedule_minutes,
  s.last_attempt_at,
  s.last_success_at,
  s.rows_processed,
  s.error,
  extract(epoch from (now() - s.last_success_at)) / 60.0 as minutes_since_success,
  case
    when s.last_success_at is null then 'never'
    when now() - s.last_success_at > (2 * s.schedule_minutes) * interval '1 minute' then 'stale'
    when now() - s.last_success_at > s.schedule_minutes * interval '1 minute' then 'late'
    else 'fresh'
  end as freshness,
  (s.last_success_at is null
    or now() - s.last_success_at > (2 * s.schedule_minutes) * interval '1 minute') as is_stale
from integration_sync_status s;

-- ---------------------------------------------------------------------------
-- Client performance, per client per ET day.
-- spend: Cortana. leads/booked/confirmed: GHL, test leads excluded.
-- shows/closes/revenue: client dashboard webhook.
-- A missing source row leaves that column null; it is never filled with 0.
-- ---------------------------------------------------------------------------
create view client_performance_daily with (security_invoker = true) as
with ads as (
  select client_id, date as day, spend, impressions, clicks
  from ad_metrics_daily
),
l as (
  select client_id, app_day(created_at) as day, count(*) as leads
  from leads where not is_test group by 1, 2
),
b as (
  select client_id, app_day(booked_at) as day, count(*) as booked
  from leads where not is_test and booked_at is not null group by 1, 2
),
c as (
  select client_id, app_day(confirmed_at) as day, count(*) as confirmed
  from leads where not is_test and confirmed_at is not null group by 1, 2
),
a as (
  select ap.client_id, app_day(ap.scheduled_for) as day,
    count(*) filter (where ap.attendance = 'showed') as shows,
    count(*) filter (where ap.attendance = 'no_show') as no_shows,
    count(*) filter (where ap.attendance in ('scheduled', 'unknown') and ap.scheduled_for < now()) as outcomes_pending
  from appointments ap
  left join leads ld on ld.id = ap.lead_id
  where coalesce(ld.is_test, false) = false
  group by 1, 2
),
s as (
  select sa.client_id, app_day(sa.closed_at) as day,
    count(*) as closes, sum(sa.amount) as revenue
  from sales sa
  join appointments ap on ap.id = sa.appointment_id
  left join leads ld on ld.id = ap.lead_id
  where sa.close_status = 'closed_won' and sa.closed_at is not null
    and coalesce(ld.is_test, false) = false
  group by 1, 2
),
keys as (
  select client_id, day from ads
  union select client_id, day from l
  union select client_id, day from b
  union select client_id, day from c
  union select client_id, day from a
  union select client_id, day from s
)
select
  k.client_id,
  k.day,
  ads.spend,
  ads.impressions,
  ads.clicks,
  coalesce(l.leads, 0) as leads,
  coalesce(b.booked, 0) as booked,
  coalesce(c.confirmed, 0) as confirmed,
  coalesce(a.shows, 0) as shows,
  coalesce(a.no_shows, 0) as no_shows,
  coalesce(a.outcomes_pending, 0) as outcomes_pending,
  coalesce(s.closes, 0) as closes,
  s.revenue,
  ads.spend / nullif(l.leads, 0) as cpl,
  ads.spend / nullif(b.booked, 0) as cost_per_booked,
  b.booked::numeric / nullif(l.leads, 0) as booking_rate,
  c.confirmed::numeric / nullif(b.booked, 0) as confirmation_rate,
  a.shows::numeric / nullif(a.shows + a.no_shows, 0) as show_rate,
  s.closes::numeric / nullif(a.shows, 0) as close_rate
from keys k
left join ads on ads.client_id = k.client_id and ads.day = k.day
left join l on l.client_id = k.client_id and l.day = k.day
left join b on b.client_id = k.client_id and b.day = k.day
left join c on c.client_id = k.client_id and c.day = k.day
left join a on a.client_id = k.client_id and a.day = k.day
left join s on s.client_id = k.client_id and s.day = k.day;

-- Month roll-up. Ratios are computed from the month's sums, not averaged from days.
create view client_monthly with (security_invoker = true) as
with m as (
  select
    client_id,
    date_trunc('month', day)::date as month,
    sum(spend) as spend,
    sum(impressions) as impressions,
    sum(clicks) as clicks,
    sum(leads) as leads,
    sum(booked) as booked,
    sum(confirmed) as confirmed,
    sum(shows) as shows,
    sum(no_shows) as no_shows,
    sum(outcomes_pending) as outcomes_pending,
    sum(closes) as closes,
    sum(revenue) as revenue
  from client_performance_daily
  group by 1, 2
)
select
  m.*,
  m.spend / nullif(m.leads, 0) as cpl,
  m.spend / nullif(m.booked, 0) as cost_per_booked,
  m.booked::numeric / nullif(m.leads, 0) as booking_rate,
  m.confirmed::numeric / nullif(m.booked, 0) as confirmation_rate,
  m.shows::numeric / nullif(m.shows + m.no_shows, 0) as show_rate,
  m.closes::numeric / nullif(m.shows, 0) as close_rate,
  m.clicks::numeric / nullif(m.impressions, 0) as ctr,
  m.revenue / nullif(m.spend, 0) as roas,
  m.revenue * config_value('rev_share_rate') as rev_share
from m;

create view client_mtd with (security_invoker = true) as
select * from client_monthly
where month = date_trunc('month', app_today())::date;

-- ---------------------------------------------------------------------------
-- Renewals. Renewal dates = launch_date + n x billing cycle.
-- paid    = a classified payment from 5 days before that renewal date
--           up to 5 days before the following one.
-- overdue = the most recent renewal date has passed with no such payment.
-- Amount  = monthly_fee x months in the cycle. Legacy billing renews every 30 days.
-- ---------------------------------------------------------------------------
create view renewals with (security_invoker = true) as
with base as (
  select
    c.id as client_id, c.name, c.stage, c.billing_cycle, c.monthly_fee, c.launch_date,
    case c.billing_cycle when '30' then 30 when 'legacy' then 30 when '90' then 90 end as cycle_days,
    case c.billing_cycle when '30' then 1 when 'legacy' then 1 when '90' then 3 end as cycle_months,
    app_today() as today
  from clients c
  where c.deleted_at is null and c.stage <> 'churned'
),
k as (
  select base.*,
    case when launch_date is not null and cycle_days is not null
      then greatest(floor((today - launch_date)::numeric / cycle_days), 0)::int end as cycles_done
  from base
),
d as (
  select k.*,
    case when cycles_done >= 1 then launch_date + cycles_done * cycle_days end as last_renewal_date,
    case when cycles_done is not null then launch_date + (cycles_done + 1) * cycle_days end as next_renewal_date
  from k
),
p as (
  select d.*,
    exists (
      select 1 from payments pay
      where pay.client_id = d.client_id and pay.classified
        and app_day(pay.paid_at) >= d.last_renewal_date - 5
        and app_day(pay.paid_at) < d.next_renewal_date - 5
    ) as last_paid,
    exists (
      select 1 from payments pay
      where pay.client_id = d.client_id and pay.classified
        and app_day(pay.paid_at) >= d.next_renewal_date - 5
    ) as next_paid
  from d
),
r as (
  select p.*,
    (last_renewal_date is not null and not last_paid) as last_unpaid
  from p
)
select
  client_id, name, stage, billing_cycle, monthly_fee, launch_date, cycle_months,
  monthly_fee * cycle_months as renewal_amount,
  last_renewal_date,
  next_renewal_date,
  case when last_unpaid then last_renewal_date else next_renewal_date end as renewal_date,
  case when last_unpaid then last_renewal_date else next_renewal_date end - today as days_until,
  case
    when launch_date is null then 'not_started'
    when cycle_days is null then null
    when last_unpaid and today > last_renewal_date then 'overdue'
    when last_unpaid then 'due_7d'
    when next_paid then 'paid'
    when last_renewal_date is not null and today - last_renewal_date <= 5 then 'paid'
    when next_renewal_date - today <= 7 then 'due_7d'
    else 'upcoming'
  end as status
from r;

-- ---------------------------------------------------------------------------
-- SLA. Genexa time = elapsed - paused.
-- fix: business minutes (09:00-17:00 ET, Mon-Fri). launch: wall-clock.
-- ---------------------------------------------------------------------------
create view tech_job_sla with (security_invoker = true) as
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
    case j.type
      when 'fix' then config_value('sla_fix_business_minutes')
      when 'launch' then config_value('sla_launch_hours') * 60
    end as sla_minutes,
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

-- Launch clock starts when both the onboarding form and access are done.
create view launch_sla with (security_invoker = true) as
with l as (
  select la.*,
    case when la.ob_form_done_at is not null and la.access_done_at is not null
      then greatest(la.ob_form_done_at, la.access_done_at) end as clock_start,
    coalesce(la.live_at, now()) as end_at
  from launches la
),
m as (
  select
    l.id as launch_id, l.client_id, l.clock_start, l.end_at, l.live_at, l.paid_at,
    config_value('sla_launch_hours') * 60 as sla_minutes,
    extract(epoch from (l.end_at - l.clock_start)) / 60.0 as elapsed_minutes,
    coalesce((
      select sum(greatest(extract(epoch from (
        least(coalesce(sp.resumed_at, l.end_at), l.end_at) - greatest(sp.paused_at, l.clock_start))) / 60.0, 0))
      from sla_pauses sp where sp.launch_id = l.id
    ), 0) as paused_minutes,
    exists (select 1 from sla_pauses sp where sp.launch_id = l.id and sp.resumed_at is null) as is_paused
  from l
)
select
  launch_id,
  client_id,
  clock_start,
  sla_minutes,
  elapsed_minutes,
  paused_minutes,
  greatest(elapsed_minutes - paused_minutes, 0) as genexa_minutes,
  is_paused,
  case when clock_start is null then null
    else greatest(elapsed_minutes - paused_minutes, 0) > sla_minutes end as is_overdue,
  case when live_at is null or clock_start is null then null
    else greatest(elapsed_minutes - paused_minutes, 0) <= sla_minutes end as met_sla,
  case when live_at is null and paid_at is not null
    then app_today() - app_day(paid_at) end as days_waiting_since_paid
from m;

-- ---------------------------------------------------------------------------
-- Weekly scores (Mon-Sun ET), long format: one row per person per metric.
-- Built as a union of per-metric views; each scorecard phase adds its own.
-- ---------------------------------------------------------------------------
-- EODs. Colour is scored on EODs missed so far, which is the brief's threshold
-- (5 of 5 green, 4 amber, <=3 red; CSR 6-7 / 4-5 / <=3) without marking the
-- current week red before its days have happened. Today is not due until midnight.
create view score_eods_weekly with (security_invoker = true) as
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

create view person_scores_weekly with (security_invoker = true) as
select
  s.staff_id, s.week_start, s.card, s.metric, s.value, s.numerator, s.denominator, s.colour,
  coalesce(s.week_start = app_week_start(
    (select (value #>> '{}')::date from app_settings where key = 'go_live_date')), false) as is_baseline
from score_eods_weekly s;
