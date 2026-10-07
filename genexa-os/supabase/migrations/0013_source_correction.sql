-- Source correction.
--   Cortana = everything patient-side per clinic: ads, funnel, outcomes (all sources, not only Meta).
--   Whop (direct API) = Genexa's own money: payments, memberships, renewals, cancellations.
--   GHL = only what Cortana does not hold (call attempts, first-call time, who called).

-- ---------------------------------------------------------------------------
-- Cortana conversion events: one row per event, with its contact and attribution.
-- Every funnel and outcome number is a count of these rows, so it drills to them.
-- Only the contact's first name is stored.
-- ---------------------------------------------------------------------------
create table cortana_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  cortana_entry_id text not null,
  event text not null,
  occurred_at timestamptz not null,
  value numeric(12,2),
  contact_id text not null,
  contact_first_name text,
  is_test boolean not null default false,
  attribution_source text,
  campaign_id text,
  campaign_name text,
  ad_id text,
  ad_name text,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, cortana_entry_id)
);
create index cortana_events_client_time_idx on cortana_events (client_id, occurred_at);
create index cortana_events_event_idx on cortana_events (event, occurred_at);

alter table ad_metrics_daily add column page_views bigint;
alter table ad_metrics_daily add column unique_visitors bigint;

-- ---------------------------------------------------------------------------
-- Whop (direct API)
-- ---------------------------------------------------------------------------
alter table payments add column status text not null default 'paid' check (status in ('paid', 'open'));
alter table payments add column whop_user_id text;
alter table payments add column whop_membership_id text;
alter table payments add column gross_amount numeric(12,2);
alter table payments add column refunded_amount numeric(12,2) not null default 0;
alter table payments add column billing_reason text;
create index payments_whop_user_idx on payments (whop_user_id);

create table whop_memberships (
  id uuid primary key default gen_random_uuid(),
  whop_membership_id text not null unique,
  client_id uuid references clients(id),
  whop_user_id text,
  email text,
  product_title text,
  status text,
  valid boolean not null default false,
  cancel_at_period_end boolean not null default false,
  -- From the Whop plan: how often it renews and for how much. Null = a one-off purchase.
  billing_period_days integer,
  renewal_price numeric(12,2),
  renewal_period_start timestamptz,
  renewal_period_end timestamptz,
  started_at timestamptz,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index whop_memberships_client_idx on whop_memberships (client_id);

do $$
declare t text;
begin
  foreach t in array array['cortana_events', 'whop_memberships'] loop
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', t || '_set_updated_at', t);
    execute format('create trigger %I before delete on %I for each row execute function forbid_delete()', t || '_forbid_delete', t);
    execute format('alter table %I enable row level security', t);
    execute format('create policy owner_all on %I for all to authenticated using (app_is_owner()) with check (app_is_owner())', t);
    execute format('create policy staff_read on %I for select to authenticated using (app_staff_id() is not null)', t);
  end loop;
end $$;

insert into app_settings (key, value) values ('whop_excluded_products', '["Irrigation Growth Plan"]')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Client performance per ET day, all from Cortana.
--   spend, impressions, clicks: paid Meta campaigns in the clinic's scope.
--   page views, visitors: Cortana tracking, all sources.
--   leads ... revenue: unique contacts per event that day, all sources, test contacts excluded.
-- Clinics whose Cortana business is unverified are left out entirely.
-- ---------------------------------------------------------------------------
drop view client_mtd;
drop view client_monthly;
drop view client_performance_daily;

create view client_performance_daily with (security_invoker = true) as
with ads as (
  select client_id, date as day, spend, impressions, clicks, page_views, unique_visitors
  from ad_metrics_daily
),
ev as (
  select
    e.client_id, app_day(e.occurred_at) as day,
    count(distinct e.contact_id) filter (where e.event = 'lead') as leads,
    count(distinct e.contact_id) filter (where e.event = 'unconfirmed_appointment_booked') as booked,
    count(distinct e.contact_id) filter (where e.event = 'appointment_booked') as confirmed,
    count(distinct e.contact_id) filter (where e.event = 'appointment_shown') as shows,
    count(distinct e.contact_id) filter (where e.event = 'appointment_no_show') as no_shows,
    count(distinct e.contact_id) filter (where e.event = 'appointment_cancelled') as cancelled,
    count(*) filter (where e.event = 'purchase') as closes,
    sum(e.value) filter (where e.event = 'purchase') as revenue
  from cortana_events e
  where not e.is_test
  group by 1, 2
),
keys as (
  select client_id, day from ads union select client_id, day from ev
)
select
  k.client_id,
  k.day,
  ads.spend,
  ads.impressions,
  ads.clicks,
  ads.page_views,
  ads.unique_visitors,
  coalesce(ev.leads, 0) as leads,
  coalesce(ev.booked, 0) as booked,
  coalesce(ev.confirmed, 0) as confirmed,
  coalesce(ev.shows, 0) as shows,
  coalesce(ev.no_shows, 0) as no_shows,
  coalesce(ev.cancelled, 0) as cancelled,
  coalesce(ev.closes, 0) as closes,
  ev.revenue,
  ads.spend / nullif(ev.leads, 0) as cpl,
  ads.spend / nullif(ev.booked, 0) as cost_per_booked,
  ev.leads::numeric / nullif(ads.unique_visitors, 0) as lp_conversion_rate,
  ev.booked::numeric / nullif(ev.leads, 0) as booking_rate,
  ev.confirmed::numeric / nullif(ev.booked, 0) as confirmation_rate,
  ev.shows::numeric / nullif(ev.shows + ev.no_shows, 0) as show_rate,
  ev.closes::numeric / nullif(ev.shows, 0) as close_rate
from keys k
left join ads on ads.client_id = k.client_id and ads.day = k.day
left join ev on ev.client_id = k.client_id and ev.day = k.day
where k.client_id not in (select client_id from clients_ads_unverified);

create view client_monthly with (security_invoker = true) as
with m as (
  select
    client_id,
    date_trunc('month', day)::date as month,
    sum(spend) as spend, sum(impressions) as impressions, sum(clicks) as clicks,
    sum(page_views) as page_views, sum(unique_visitors) as unique_visitors,
    sum(leads) as leads, sum(booked) as booked, sum(confirmed) as confirmed,
    sum(shows) as shows, sum(no_shows) as no_shows, sum(cancelled) as cancelled,
    sum(closes) as closes, sum(revenue) as revenue
  from client_performance_daily
  group by 1, 2
)
select
  m.*,
  m.spend / nullif(m.leads, 0) as cpl,
  m.spend / nullif(m.booked, 0) as cost_per_booked,
  m.leads::numeric / nullif(m.unique_visitors, 0) as lp_conversion_rate,
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

-- Totals for a date range. Patient-side numbers from Cortana, cash from Whop, bank from Mercury.
create or replace function overview_period(p_from date, p_to date)
returns table (
  ad_spend numeric, leads numeric, booked numeric, confirmed numeric, shows numeric, no_shows numeric,
  closes numeric, clinic_revenue numeric, cash_collected numeric, expenses numeric, bank_revenue numeric)
language sql stable as $$
  select
    p.ad_spend, p.leads, p.booked, p.confirmed, p.shows, p.no_shows, p.closes, p.clinic_revenue,
    (select coalesce(sum(pay.amount), 0) from payments pay
      where pay.classified and pay.status = 'paid' and app_day(pay.paid_at) between p_from and p_to),
    (select sum(abs(t.amount)) from finance_transactions t
      where t.included and t.category in ('ads','software','payroll','other')
        and app_day(t.posted_at) between p_from and p_to),
    (select sum(abs(t.amount)) from finance_transactions t
      where t.included and t.category = 'revenue' and app_day(t.posted_at) between p_from and p_to)
  from (
    select sum(d.spend) as ad_spend, coalesce(sum(d.leads), 0) as leads, coalesce(sum(d.booked), 0) as booked,
      coalesce(sum(d.confirmed), 0) as confirmed, coalesce(sum(d.shows), 0) as shows, coalesce(sum(d.no_shows), 0) as no_shows,
      coalesce(sum(d.closes), 0) as closes, coalesce(sum(d.revenue), 0) as clinic_revenue
    from client_performance_daily d where d.day between p_from and p_to
  ) p
$$;

update exception_rules set sources = '{cortana}' where type = 'account_cpb_high';

create or replace view exception_detections with (security_invoker = true) as
-- Live client, $0 spend for all of yesterday and so far today.
select
  'zero_spend'::text as type,
  'zero_spend:' || c.client_id as dedupe_key,
  c.client_id,
  null::uuid as staff_id,
  app_role_holder('media_buyer') as owner_id,
  null::text as owner_pod,
  'red'::text as severity,
  c.name || ': $0 ad spend since ' || to_char(app_today() - 1, 'Dy DD Mon') as reason,
  c.cycle_fee as money_at_risk,
  'clients'::text as record_table,
  c.client_id as record_id
from clients_ads_trusted c
join ad_metrics_daily y on y.client_id = c.client_id and y.date = app_today() - 1
left join ad_metrics_daily t on t.client_id = c.client_id and t.date = app_today()
where c.stage = 'live'
  and (c.launch_date is null or c.launch_date < app_today() - 1)
  and y.spend = 0
  and coalesce(t.spend, 0) = 0

union all
-- Account 7d cost per booked over the red line. Spend and bookings: Cortana.
select
  'account_cpb_high', 'account_cpb_high:' || c.client_id, c.client_id, null,
  app_role_holder('media_buyer'), null, 'red',
  c.name || ': 7d cost per booked $' || round(w.spend / w.booked) || ' (' || w.booked || ' booked on $' || round(w.spend) || ')',
  0::numeric, 'clients', c.client_id
from clients_ads_trusted c
join lateral (
  select
    (select sum(d.spend) from ad_metrics_daily d
      where d.client_id = c.client_id and d.date between app_today() - 7 and app_today() - 1) as spend,
    (select sum(p.booked) from client_performance_daily p
      where p.client_id = c.client_id and p.day between app_today() - 7 and app_today() - 1) as booked
) w on true
where c.stage = 'live'
  and w.booked > 0
  and w.spend / w.booked > (select amber from scoring_config where key = 'cost_per_booked_7d')

union all
-- Ad fatigue: 7d frequency above the line, or 7d CTR down 30% against all-time.
select
  'ad_fatigue', 'ad_fatigue:' || c.client_id || ':' || w.ad_id, c.client_id, null,
  app_role_holder('media_buyer'), null, 'amber',
  c.name || ' · ' || coalesce(w.ad_name, w.ad_id) || ': ' ||
    case when w.frequency > config_value('ad_fatigue_frequency')
      then '7d frequency ' || round(w.frequency, 2)
      else '7d CTR ' || round(w.ctr, 2) || '% vs ' || round(a.ctr, 2) || '% all-time' end,
  0::numeric, 'ad_metrics_ad_window', w.id
from clients_ads_trusted c
join ad_metrics_ad_window w on w.client_id = c.client_id and w.period = '7d'
left join ad_metrics_ad_window a on a.client_id = w.client_id and a.ad_id = w.ad_id and a.period = 'all'
where c.stage = 'live'
  and w.ad_status = 'ACTIVE'
  and w.spend > 0
  and (
    w.frequency > config_value('ad_fatigue_frequency')
    or (a.ctr > 0 and w.ctr is not null
        and w.ctr <= a.ctr * (1 - config_value('ad_fatigue_ctr_drop_pct') / 100.0))
  )

union all
-- Ad spending without bookings (all-time totals for an ad that is still running).
select
  'ad_performance', 'ad_performance:' || c.client_id || ':' || a.ad_id, c.client_id, null,
  app_role_holder('media_buyer'), null, 'amber',
  c.name || ' · ' || coalesce(a.ad_name, a.ad_id) || ': ' ||
    case
      when a.spend >= config_value('ad_spend_no_booking') and coalesce(a.booked, 0) = 0
        then '$' || round(a.spend) || ' spent, 0 bookings'
      when a.spend >= config_value('ad_spend_cpb_check') and a.booked > 0 and a.spend / a.booked > config_value('ad_cpb_max')
        then 'cost per booked $' || round(a.spend / a.booked) || ' on $' || round(a.spend)
      else 'booking rate ' || round(100.0 * coalesce(a.booked, 0) / a.leads) || '% on ' || a.leads || ' leads'
    end,
  0::numeric, 'ad_metrics_ad_window', a.id
from clients_ads_trusted c
join ad_metrics_ad_window a on a.client_id = c.client_id and a.period = 'all'
where c.stage = 'live'
  and a.ad_status = 'ACTIVE'
  and (
    (a.spend >= config_value('ad_spend_no_booking') and coalesce(a.booked, 0) = 0)
    or (a.spend >= config_value('ad_spend_cpb_check') and a.booked > 0 and a.spend / a.booked > config_value('ad_cpb_max'))
    or (a.leads >= config_value('ad_min_leads_for_rate')
        and 100.0 * coalesce(a.booked, 0) / a.leads < config_value('ad_min_booking_rate_pct'))
  )

union all
select
  'ad_disapproved', 'ad_disapproved:' || c.client_id || ':' || w.ad_id, c.client_id, null,
  app_role_holder('media_buyer'), null, 'red',
  c.name || ' · ' || coalesce(w.ad_name, w.ad_id) || ': disapproved by Meta',
  0::numeric, 'ad_metrics_ad_window', w.id
from clients_ads_trusted c
join ad_metrics_ad_window w on w.client_id = c.client_id and w.period = '7d'
where c.stage = 'live' and w.ad_status = 'DISAPPROVED'

union all
-- Tech job past due in Genexa time (a paused job is not counting).
select
  'tech_job_overdue', 'tech_job_overdue:' || j.id, j.client_id, null,
  coalesce(j.owner_id, app_role_holder('tech')), null, 'red',
  j.title || ': ' || round(s.genexa_minutes - coalesce(s.sla_minutes, 0)) || ' min over SLA',
  0::numeric, 'tech_jobs', j.id
from tech_jobs j
join tech_job_sla s on s.tech_job_id = j.id
where j.deleted_at is null and j.status <> 'done' and s.is_overdue and not s.is_paused

union all
-- Launch past the 48h SLA. Money at risk = what the client paid for the current term.
select
  'launch_sla_breached', 'launch_sla_breached:' || l.id, l.client_id, null,
  coalesce(l.owner_id, app_role_holder('tech')), null, 'red',
  c.name || ': launch ' || round((s.genexa_minutes - s.sla_minutes) / 60.0) || 'h past the 48h SLA',
  c.cycle_fee, 'launches', l.id
from launches l
join launch_sla s on s.launch_id = l.id
join clients c on c.id = l.client_id
where l.live_at is null and s.is_overdue and not s.is_paused and c.deleted_at is null

union all
select
  'sla_pause_long', 'sla_pause_long:' || p.id, coalesce(j.client_id, l.client_id), null,
  app_role_holder('owner'), null, 'amber',
  coalesce(j.title, 'Launch') || ': paused ' || round(extract(epoch from (now() - p.paused_at)) / 3600) || 'h (' || p.reason || ')',
  0::numeric, 'sla_pauses', p.id
from sla_pauses p
left join tech_jobs j on j.id = p.tech_job_id
left join launches l on l.id = p.launch_id
where p.resumed_at is null
  and now() - p.paused_at > config_value('sla_pause_max_hours') * interval '1 hour';;


-- ---------------------------------------------------------------------------
-- Renewals. Whop is the source of truth: a client with a live recurring Whop
-- membership renews when Whop says, for what the Whop plan charges.
-- A client with no recurring membership (paid by one-off links) falls back to
-- launch date + billing cycle, checked against Whop payments.
-- ---------------------------------------------------------------------------
drop view client_health;
drop view client_health_reasons;
drop view renewals;

create view renewals_by_launch_date with (security_invoker = true) as
with base as (
  select
    c.id as client_id, c.name, c.stage, c.billing_cycle, c.cycle_fee, c.monthly_fee, c.launch_date,
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
      where pay.client_id = d.client_id and pay.classified and pay.status = 'paid'
        and app_day(pay.paid_at) >= d.last_renewal_date - 5
        and app_day(pay.paid_at) < d.next_renewal_date - 5
    ) as last_paid,
    exists (
      select 1 from payments pay
      where pay.client_id = d.client_id and pay.classified and pay.status = 'paid'
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
  client_id, name, stage, billing_cycle, cycle_fee, monthly_fee, launch_date, cycle_months,
  cycle_fee as renewal_amount,
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

create view renewals with (security_invoker = true) as
with m as (
  select distinct on (w.client_id) w.*
  from whop_memberships w
  where w.client_id is not null and w.valid and w.billing_period_days is not null and w.renewal_period_end is not null
  order by w.client_id, w.renewal_period_end desc
)
select
  c.id as client_id, c.name, c.stage, c.billing_cycle, c.cycle_fee, c.monthly_fee, c.launch_date,
  case when m.client_id is not null then 'whop' else 'launch_date' end as source,
  coalesce(m.renewal_price, f.renewal_amount) as renewal_amount,
  case when m.client_id is not null then app_day(m.renewal_period_end) else f.renewal_date end as renewal_date,
  case when m.client_id is not null then app_day(m.renewal_period_end) - app_today() else f.days_until end as days_until,
  case
    when m.client_id is null then f.status
    when m.cancel_at_period_end then 'cancelling'
    when app_day(m.renewal_period_end) < app_today() then 'overdue'
    when app_day(m.renewal_period_start) >= app_today() - 5 then 'paid'
    when app_day(m.renewal_period_end) - app_today() <= 7 then 'due_7d'
    else 'upcoming'
  end as status,
  m.cancel_at_period_end as cancelling,
  m.billing_period_days as whop_period_days
from clients c
left join m on m.client_id = c.id
left join renewals_by_launch_date f on f.client_id = c.id
where c.deleted_at is null and c.stage <> 'churned';

create view client_health_reasons with (security_invoker = true) as
with stale as (
  select coalesce(array_agg(source), '{}') as sources from source_freshness where is_stale
),
live as (
  select c.* from clients c where c.deleted_at is null and c.stage <> 'churned'
),
r as (
  select d.client_id, 'red'::text as severity, 'zero_spend'::text as rule, '$0 ad spend 24h+'::text as reason, array['cortana'] as sources
  from exception_detections d where d.type = 'zero_spend'
  union all
  select rn.client_id, 'red', 'renewal_overdue', 'Renewal overdue since ' || to_char(rn.renewal_date, 'DD Mon'), array['whop']
  from renewals rn where rn.status = 'overdue'
  union all
  select l.client_id, score_colour('health_paid_not_launched_days', s.days_waiting_since_paid::numeric),
    'paid_not_launched', 'Paid ' || s.days_waiting_since_paid || ' days ago, not launched', array[]::text[]
  from launches l join launch_sla s on s.launch_id = l.id
  where l.live_at is null and s.days_waiting_since_paid is not null
  union all
  select c.id, score_colour('health_no_reply_days', (app_today() - app_day(c.last_reply_client))::numeric),
    'no_reply', 'No client reply for ' || (app_today() - app_day(c.last_reply_client)) || ' days', array[]::text[]
  from live c where c.stage = 'live' and c.last_reply_client is not null
  union all
  select c.id,
    case when score_colour('cost_per_booked_7d', w.spend / w.booked) = 'red'
          and (c.launch_date is null or app_today() - c.launch_date < config_value('health_cpb_grace_days'))
      then 'amber' else score_colour('cost_per_booked_7d', w.spend / w.booked) end,
    'cost_per_booked', '7d cost per booked $' || round(w.spend / w.booked), array['cortana']
  from live c
  join lateral (
    select
      (select sum(d.spend) from ad_metrics_daily d where d.client_id = c.id and d.date between app_today() - 7 and app_today() - 1) as spend,
      (select sum(p.booked) from client_performance_daily p where p.client_id = c.id and p.day between app_today() - 7 and app_today() - 1) as booked
  ) w on true
  where c.stage = 'live' and w.booked > 0 and w.spend is not null
    and c.id not in (select client_id from clients_ads_unverified)
  union all
  select a.client_id, 'amber', 'outcomes_overdue', count(*) || ' outcomes overdue 48h+', array['ghl']
  from appointments a left join leads l on l.id = a.lead_id
  where a.attendance = 'scheduled' and coalesce(l.is_test, false) = false
    and a.scheduled_for < now() - config_value('health_outcomes_overdue_hours') * interval '1 hour'
  group by a.client_id
  union all
  select c.id, 'red', 'guarantee', 'Guarantee due ' || to_char(c.guarantee_deadline, 'DD Mon') || ': $' ||
      round(coalesce(g.revenue, 0)) || ' of $' || round(c.guarantee_target_amount),
    array['cortana']
  from live c
  join lateral (
    select sum(p.revenue) as revenue from client_performance_daily p
    where p.client_id = c.id and (c.launch_date is null or p.day >= c.launch_date)
  ) g on true
  where c.guarantee_deadline is not null and c.guarantee_target_amount is not null
    and c.guarantee_deadline - app_today() between 0 and config_value('health_guarantee_window_days')
    and coalesce(g.revenue, 0) < c.guarantee_target_amount
)
select r.client_id, r.severity, r.rule, r.reason
from r, stale
where r.severity in ('red', 'amber') and not (r.sources && stale.sources);;

create view client_health with (security_invoker = true) as
select
  c.id as client_id, c.name, c.stage, c.pod,
  case
    when bool_or(h.severity = 'red') then 'red'
    when bool_or(h.severity = 'amber') then 'amber'
    else 'green'
  end as colour,
  string_agg(h.reason, ' · ' order by case h.severity when 'red' then 0 else 1 end, h.rule) as reasons,
  (c.cortana_business_id is not null) as cortana_connected,
  (select coalesce(array_agg(f.source order by f.source), '{}') from source_freshness f
    where f.is_stale and f.source in ('cortana', 'whop')) as sources_missing
from clients c
left join client_health_reasons h on h.client_id = c.id
where c.deleted_at is null and c.stage <> 'churned'
group by c.id, c.name, c.stage, c.pod, c.cortana_business_id;

create or replace view data_review_items with (security_invoker = true) as
-- Appointments 24h+ past with no attendance logged.
select 'unlogged_outcome'::text as kind, 'appointments'::text as record_table, a.id as record_id, a.client_id,
  coalesce(split_part(l.name, ' ', 1), 'Patient') || ' · ' || c.name as title,
  'Consult ' || to_char(a.scheduled_for at time zone 'America/New_York', 'Dy DD Mon HH24:MI') || ' ET, no outcome logged' as detail,
  a.scheduled_for as occurred_at
from appointments a
join clients c on c.id = a.client_id
left join leads l on l.id = a.lead_id
where a.attendance = 'scheduled' and a.scheduled_for < now() - interval '24 hours' and coalesce(l.is_test, false) = false

union all
select 'unmatched_payment', 'payments', p.id, null,
  coalesce(p.customer_name, p.customer_email, 'Unknown customer') || ' · $' || p.amount,
  coalesce(p.product_title, 'no product title') || ' · ' || case p.status when 'paid' then 'paid ' else 'invoice opened ' end
    || to_char(p.paid_at at time zone 'America/New_York', 'DD Mon') || coalesce(' · ' || p.customer_email, ''),
  p.paid_at
from payments p where p.client_id is null

union all
select 'uncategorised_expense', 'finance_transactions', t.id, null,
  coalesce(t.counterparty, 'Unknown') || ' · $' || abs(t.amount),
  'Posted ' || to_char(t.posted_at at time zone 'America/New_York', 'DD Mon'),
  t.posted_at
from finance_transactions t where t.category = 'unclassified'

union all
-- Missing EODs in the last 7 days, counted only from the go-live date.
select 'eod_issue', 'staff', s.id, null,
  s.name || ' · no EOD for ' || to_char(d.day, 'Dy DD Mon'),
  'Missing EOD', d.day::timestamptz
from staff s
cross join lateral generate_series(app_today() - 7, app_today() - 1, interval '1 day') as d(day)
where s.status <> 'left' and s.role in ('csr', 'tech', 'media_buyer')
  and d.day::date >= (select (value #>> '{}')::date from app_settings where key = 'go_live_date')
  and (s.start_date is null or d.day::date >= s.start_date)
  and extract(isodow from d.day)::smallint = any (s.working_days)
  and not exists (select 1 from eods e where e.staff_id = s.id and e.date = d.day::date)

union all
select 'test_lead', 'leads', l.id, l.client_id,
  coalesce(l.name, 'Unnamed') || ' · ' || c.name,
  'Flagged as a test lead, created ' || to_char(l.created_at at time zone 'America/New_York', 'DD Mon'),
  l.created_at
from leads l join clients c on c.id = l.client_id
where l.is_test and c.stage = 'live' and l.created_at > now() - interval '7 days'

union all
select 'anomaly', 'clients', c.id, c.id, c.name || ' · live with no launch date',
  'Renewals, days live and the ad SOP stage show no data until it is set', c.created_at
from clients c where c.deleted_at is null and c.stage = 'live' and c.launch_date is null
union all
select 'anomaly', 'clients', c.id, c.id, c.name || ' · no fee on record',
  'Excluded from MRR and from money at risk', c.created_at
from clients c where c.deleted_at is null and c.stage <> 'churned' and c.cycle_fee is null
union all
select 'anomaly', 'clients', c.id, c.id, c.name || ' · no billing cycle',
  'No renewal date can be worked out', c.created_at
from clients c where c.deleted_at is null and c.stage <> 'churned' and c.billing_cycle is null
union all
select 'anomaly', 'clients', c.id, c.id, c.name || ' · not connected to Cortana',
  'Live with no Cortana business: no ad numbers and no ad alerts', c.created_at
from clients c where c.deleted_at is null and c.stage = 'live' and c.cortana_business_id is null
union all
select 'anomaly', 'client_campaign_scope', s.id, s.client_id, c.name || ' · ad numbers unverified',
  coalesce(s.note, 'Campaign scope has not been verified'), s.created_at
from client_campaign_scope s join clients c on c.id = s.client_id where not s.verified and c.deleted_at is null
union all
-- Two clinics reporting the same non-zero spend, to the cent, on 2+ of the last 7 days.
select 'anomaly', 'clients', a.client_id, a.client_id,
  ca.name || ' · same daily spend as ' || cb.name,
  'Identical spend on ' || count(*) || ' of the last 7 days: one Cortana business is probably reading the other''s ad account',
  max(a.date)::timestamptz
from ad_metrics_daily a
join ad_metrics_daily b on b.date = a.date and b.spend = a.spend and b.client_id > a.client_id
join clients ca on ca.id = a.client_id
join clients cb on cb.id = b.client_id
where a.spend > 0 and a.date between app_today() - 7 and app_today() - 1
group by a.client_id, ca.name, cb.name
having count(*) >= 2

union all
-- Whop invoices that were raised and never paid.
select 'anomaly', 'payments', p.id, p.client_id,
  coalesce(c.name, p.customer_name, 'Unknown customer') || ' · unpaid Whop invoice $' || p.amount,
  coalesce(p.product_title, 'no product title') || ' · opened ' || to_char(p.paid_at at time zone 'America/New_York', 'DD Mon'),
  p.paid_at
from payments p left join clients c on c.id = p.client_id
where p.status = 'open' and p.paid_at > now() - interval '60 days'

union all
-- The fee on record disagrees with what Whop charges on the client's live plan.
select 'anomaly', 'clients', c.id, c.id,
  c.name || ' · fee on record $' || c.cycle_fee || ', Whop plan $' || m.renewal_price,
  'Whop renews $' || m.renewal_price || ' every ' || m.billing_period_days || ' days; the client record says $' || c.cycle_fee || ' every '
    || case c.billing_cycle when '90' then '90' else '30' end || ' days',
  m.synced_at
from clients c
join whop_memberships m on m.client_id = c.id and m.valid and m.billing_period_days is not null and m.renewal_price is not null
where c.deleted_at is null and c.stage <> 'churned' and c.cycle_fee is not null
  and (m.renewal_price <> c.cycle_fee or m.billing_period_days <> case c.billing_cycle when '90' then 90 else 30 end);
;
