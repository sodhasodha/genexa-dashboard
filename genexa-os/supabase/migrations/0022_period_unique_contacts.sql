-- A period total counts each patient once per clinic, the way Cortana does.
-- Summing daily counts double-counted a patient who booked on two different days
-- (Vitale, 1-7 Oct: 8 by day, 7 patients).

-- Funnel per clinic for any ET date range: unique contacts per event, test
-- contacts and unverified clinics excluded.
create function client_funnel_period(p_from date, p_to date)
returns table (
  client_id uuid, leads bigint, booked bigint, confirmed bigint, shows bigint, no_shows bigint,
  cancelled bigint, closes bigint, revenue numeric)
language sql stable as $$
  select
    e.client_id,
    count(distinct e.contact_id) filter (where e.event = 'lead'),
    count(distinct e.contact_id) filter (where e.event = 'unconfirmed_appointment_booked'),
    count(distinct e.contact_id) filter (where e.event = 'appointment_booked'),
    count(distinct e.contact_id) filter (where e.event = 'appointment_shown'),
    count(distinct e.contact_id) filter (where e.event = 'appointment_no_show'),
    count(distinct e.contact_id) filter (where e.event = 'appointment_cancelled'),
    count(*) filter (where e.event = 'purchase'),
    sum(e.value) filter (where e.event = 'purchase')
  from cortana_events e
  where not e.is_test
    and app_day(e.occurred_at) between p_from and p_to
    and e.client_id not in (select u.client_id from clients_ads_unverified u)
  group by e.client_id
$$;

create or replace function overview_period(p_from date, p_to date)
returns table (
  ad_spend numeric, leads numeric, booked numeric, confirmed numeric, shows numeric, no_shows numeric,
  closes numeric, clinic_revenue numeric, cash_collected numeric, expenses numeric, bank_revenue numeric)
language sql stable as $$
  select
    (select sum(d.spend) from ad_metrics_daily d
      where d.date between p_from and p_to
        and d.client_id not in (select u.client_id from clients_ads_unverified u)),
    f.leads, f.booked, f.confirmed, f.shows, f.no_shows, f.closes, f.clinic_revenue,
    (select coalesce(sum(pay.amount), 0) from payments pay
      where pay.classified and pay.status = 'paid' and app_day(pay.paid_at) between p_from and p_to),
    (select sum(abs(t.amount)) from finance_transactions t
      where t.included and t.category in ('ads','software','payroll','other')
        and app_day(t.posted_at) between p_from and p_to),
    (select sum(abs(t.amount)) from finance_transactions t
      where t.included and t.category = 'revenue' and app_day(t.posted_at) between p_from and p_to)
  from (
    select coalesce(sum(leads), 0)::numeric as leads, coalesce(sum(booked), 0)::numeric as booked,
      coalesce(sum(confirmed), 0)::numeric as confirmed, coalesce(sum(shows), 0)::numeric as shows,
      coalesce(sum(no_shows), 0)::numeric as no_shows, coalesce(sum(closes), 0)::numeric as closes,
      coalesce(sum(revenue), 0) as clinic_revenue
    from client_funnel_period(p_from, p_to)
  ) f
$$;

-- Month roll-up: ad numbers summed from days, funnel counted once per patient per month.
drop view client_mtd;
drop view client_monthly;

create view client_monthly with (security_invoker = true) as
with ads as (
  select client_id, date_trunc('month', day)::date as month,
    sum(spend) as spend, sum(impressions) as impressions, sum(clicks) as clicks,
    sum(page_views) as page_views, sum(unique_visitors) as unique_visitors
  from client_performance_daily
  group by 1, 2
),
ev as (
  select e.client_id, date_trunc('month', app_day(e.occurred_at))::date as month,
    count(distinct e.contact_id) filter (where e.event = 'lead') as leads,
    count(distinct e.contact_id) filter (where e.event = 'unconfirmed_appointment_booked') as booked,
    count(distinct e.contact_id) filter (where e.event = 'appointment_booked') as confirmed,
    count(distinct e.contact_id) filter (where e.event = 'appointment_shown') as shows,
    count(distinct e.contact_id) filter (where e.event = 'appointment_no_show') as no_shows,
    count(distinct e.contact_id) filter (where e.event = 'appointment_cancelled') as cancelled,
    count(*) filter (where e.event = 'purchase') as closes,
    sum(e.value) filter (where e.event = 'purchase') as revenue
  from cortana_events e
  where not e.is_test and e.client_id not in (select u.client_id from clients_ads_unverified u)
  group by 1, 2
),
m as (
  select
    coalesce(ads.client_id, ev.client_id) as client_id,
    coalesce(ads.month, ev.month) as month,
    ads.spend, ads.impressions, ads.clicks, ads.page_views, ads.unique_visitors,
    coalesce(ev.leads, 0)::numeric as leads, coalesce(ev.booked, 0)::numeric as booked,
    coalesce(ev.confirmed, 0)::numeric as confirmed, coalesce(ev.shows, 0)::numeric as shows,
    coalesce(ev.no_shows, 0)::numeric as no_shows, coalesce(ev.cancelled, 0)::numeric as cancelled,
    coalesce(ev.closes, 0)::numeric as closes, ev.revenue
  from ads full join ev on ev.client_id = ads.client_id and ev.month = ads.month
)
select
  m.*,
  m.spend / nullif(m.leads, 0) as cpl,
  m.spend / nullif(m.booked, 0) as cost_per_booked,
  m.leads / nullif(m.unique_visitors, 0) as lp_conversion_rate,
  m.booked / nullif(m.leads, 0) as booking_rate,
  m.confirmed / nullif(m.booked, 0) as confirmation_rate,
  m.shows / nullif(m.shows + m.no_shows, 0) as show_rate,
  m.closes / nullif(m.shows, 0) as close_rate,
  m.clicks::numeric / nullif(m.impressions, 0) as ctr,
  m.revenue / nullif(m.spend, 0) as roas,
  m.revenue * config_value('rev_share_rate') as rev_share
from m;

create view client_mtd with (security_invoker = true) as
select * from client_monthly
where month = date_trunc('month', app_today())::date;
