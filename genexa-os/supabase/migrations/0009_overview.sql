-- Overview: period totals, client health, the data review queue, shift check.

-- ---------------------------------------------------------------------------
-- Is this person on shift right now? Reminders are held to shift hours.
-- ---------------------------------------------------------------------------
create function staff_on_shift(p_staff uuid, p_at timestamptz default now()) returns boolean
language sql stable as $$
  select exists (
    select 1 from staff_shifts_week w
    where w.staff_id = p_staff and w.starts_at <= p_at and w.ends_at > p_at)
$$;

-- ---------------------------------------------------------------------------
-- Expense categories used by the one-click buttons on the Overview.
-- Coaching and personal are recorded but never counted as business expenses.
-- ---------------------------------------------------------------------------
alter table finance_transactions drop constraint finance_transactions_category_check;
alter table finance_transactions add constraint finance_transactions_category_check
  check (category in ('revenue','ads','software','payroll','coaching','personal','other','excluded','unclassified'));
alter table finance_rules drop constraint finance_rules_category_check;
alter table finance_rules add constraint finance_rules_category_check
  check (category in ('revenue','ads','software','payroll','coaching','personal','other','excluded'));

-- Clinics whose Cortana scope a person has not verified are left out of totals,
-- so a business that mirrors another one's ad account is not counted twice.
create view clients_ads_unverified with (security_invoker = true) as
select client_id from client_campaign_scope where not verified;

-- ---------------------------------------------------------------------------
-- Totals for any date range (ET days, inclusive). One row.
-- Each number comes from its own source; the page decides "no data" from
-- source_freshness, never from a zero here.
-- ---------------------------------------------------------------------------
create function overview_period(p_from date, p_to date)
returns table (
  ad_spend numeric, leads numeric, booked numeric, confirmed numeric, shows numeric, no_shows numeric,
  closes numeric, clinic_revenue numeric, cash_collected numeric, expenses numeric, bank_revenue numeric)
language sql stable as $$
  select
    (select sum(d.spend) from ad_metrics_daily d
      where d.date between p_from and p_to
        and d.client_id not in (select client_id from clients_ads_unverified)),
    (select coalesce(sum(p.leads), 0) from client_performance_daily p where p.day between p_from and p_to),
    (select coalesce(sum(p.booked), 0) from client_performance_daily p where p.day between p_from and p_to),
    (select coalesce(sum(p.confirmed), 0) from client_performance_daily p where p.day between p_from and p_to),
    (select coalesce(sum(p.shows), 0) from client_performance_daily p where p.day between p_from and p_to),
    (select coalesce(sum(p.no_shows), 0) from client_performance_daily p where p.day between p_from and p_to),
    (select coalesce(sum(p.closes), 0) from client_performance_daily p where p.day between p_from and p_to),
    (select coalesce(sum(p.revenue), 0) from client_performance_daily p where p.day between p_from and p_to),
    (select coalesce(sum(pay.amount), 0) from payments pay
      where pay.classified and app_day(pay.paid_at) between p_from and p_to),
    (select sum(abs(t.amount)) from finance_transactions t
      where t.included and t.category in ('ads','software','payroll','other')
        and app_day(t.posted_at) between p_from and p_to),
    (select sum(abs(t.amount)) from finance_transactions t
      where t.included and t.category = 'revenue' and app_day(t.posted_at) between p_from and p_to)
$$;

-- ---------------------------------------------------------------------------
-- Client health. One row per failing rule; a rule whose source is stale or
-- has never synced is left out, so missing data never turns a client red.
-- ---------------------------------------------------------------------------
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
    'cost_per_booked', '7d cost per booked $' || round(w.spend / w.booked), array['cortana','ghl']
  from live c
  join lateral (
    select
      (select sum(d.spend) from ad_metrics_daily d where d.client_id = c.id and d.date between app_today() - 7 and app_today() - 1) as spend,
      (select count(*) from leads l where l.client_id = c.id and not l.is_test and app_day(l.booked_at) between app_today() - 7 and app_today() - 1) as booked
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
    array['client_dashboard']
  from live c
  join lateral (
    select sum(s.amount) as revenue from sales s
    where s.client_id = c.id and s.close_status = 'closed_won' and (c.launch_date is null or app_day(s.closed_at) >= c.launch_date)
  ) g on true
  where c.guarantee_deadline is not null and c.guarantee_target_amount is not null
    and c.guarantee_deadline - app_today() between 0 and config_value('health_guarantee_window_days')
    and coalesce(g.revenue, 0) < c.guarantee_target_amount
)
select r.client_id, r.severity, r.rule, r.reason
from r, stale
where r.severity in ('red', 'amber') and not (r.sources && stale.sources);

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
  -- Sources that have never synced: this colour is based on part of the picture.
  (select coalesce(array_agg(f.source order by f.source), '{}') from source_freshness f
    where f.is_stale and f.source in ('cortana', 'ghl', 'whop', 'client_dashboard')) as sources_missing
from clients c
left join client_health_reasons h on h.client_id = c.id
where c.deleted_at is null and c.stage <> 'churned'
group by c.id, c.name, c.stage, c.pod, c.cortana_business_id;

-- ---------------------------------------------------------------------------
-- Data review queue: records a person needs to fix so the numbers stay clean.
-- ---------------------------------------------------------------------------
create view data_review_items with (security_invoker = true) as
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
  coalesce(p.product_title, 'no product title') || ' · paid ' || to_char(p.paid_at at time zone 'America/New_York', 'DD Mon'),
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
-- Two clinics reporting the same non-zero spend on 3+ of the last 7 days.
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
having count(*) >= 3;

-- ---------------------------------------------------------------------------
-- Grants. Anything created after the first RLS migration needs them stated;
-- from here on new tables and views are never readable by anon by default.
-- ---------------------------------------------------------------------------
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public grant select, insert, update on tables to authenticated;
alter default privileges in schema public grant all on tables to service_role;
revoke all on all tables in schema public from anon;
grant select, insert, update on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
