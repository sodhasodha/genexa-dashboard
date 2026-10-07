-- Mirrored spend is flagged after 2 matching days, not 3: Cleveland matched
-- Knoxville to the cent on 5 and 6 Oct and the 3-day rule missed it.
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
having count(*) >= 2;
