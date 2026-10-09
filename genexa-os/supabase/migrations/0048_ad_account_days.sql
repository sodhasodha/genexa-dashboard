-- Ad days are the ad account's own days.
--
-- Cortana files each ad-account day (spend, impressions, clicks) under that date
-- at 00:00 UTC. The sync used to ask for US Eastern midnight-to-midnight, which
-- returned the NEXT account day: every clinic's daily ad numbers were stored one
-- day early, and "yesterday" was really the unfinished current day. The sync now
-- asks for the account day itself (see lib/integrations/cortana/sync.ts); this
-- migration makes the rules use the account's own clock.

-- The ad account's timezone. Cortana does not expose it, so it defaults to the
-- clinic's own timezone (from GHL) and can be corrected per clinic here.
alter table clients add column ad_timezone text;
-- The account's daily budget on that day (campaigns that were active or spent).
alter table ad_metrics_daily add column daily_budget numeric(12,2);

-- Pure: the date and hour in a timezone at an instant.
create function ad_clock_at(p_tz text, p_at timestamptz) returns table (tz text, local_date date, local_hour integer)
language sql stable as $$
  select p_tz, (p_at at time zone p_tz)::date, extract(hour from (p_at at time zone p_tz))::int
$$;

-- "Now" for a clinic's ad account.
create function ad_account_clock(p_client uuid) returns table (tz text, local_date date, local_hour integer)
language sql stable security definer set search_path = public as $$
  select k.* from clients c
  cross join lateral ad_clock_at(coalesce(nullif(c.ad_timezone, ''), nullif(c.timezone, ''), 'America/New_York'), now()) k
  where c.id = p_client
$$;
grant execute on function ad_clock_at(text, timestamptz), ad_account_clock(uuid) to authenticated, service_role;

create or replace view exception_detections_core with (security_invoker = true) as
-- Live client, $0 spend: the last FULL day in the ad account's own timezone was $0,
-- and there is still nothing today in a reading taken after 12:00 account time.
-- The current, unfinished day is never counted as a $0 day.
select
  'zero_spend'::text as type,
  'zero_spend:' || c.client_id as dedupe_key,
  c.client_id,
  null::uuid as staff_id,
  app_role_holder('media_buyer') as owner_id,
  null::text as owner_pod,
  'red'::text as severity,
  c.name || ': $0 ad spend since ' || to_char(k.local_date - 1, 'Dy DD Mon') as reason,
  c.cycle_fee as money_at_risk,
  'clients'::text as record_table,
  c.client_id as record_id
from clients_ads_trusted c
cross join lateral ad_account_clock(c.client_id) k
join ad_metrics_daily y on y.client_id = c.client_id and y.date = k.local_date - 1
join ad_metrics_daily t on t.client_id = c.client_id and t.date = k.local_date
where c.stage = 'live'
  and (c.launch_date is null or c.launch_date < k.local_date - 1)
  and k.local_hour >= 12
  and y.spend = 0
  -- yesterday's figure was read after that day ended
  and y.synced_at >= (k.local_date::timestamp at time zone k.tz)
  and t.spend = 0
  -- today's figure was read after 12:00 account time
  and t.synced_at >= ((k.local_date + time '12:00') at time zone k.tz)

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
  and now() - p.paused_at > config_value('sla_pause_max_hours') * interval '1 hour';

-- Under-spending: the last full account day spent under 60% of the daily budget
-- (or of the 7 days before it when there is no budget). Amber, for the media
-- buyer, not urgent. A $0 day is the zero-spend rule's business, not this one's.
create or replace view exception_detections with (security_invoker = true) as
select * from exception_detections_core
union all
select
  'renewal_overdue'::text, 'renewal_overdue:' || r.client_id || ':' || r.renewal_date, r.client_id, null::uuid,
  app_role_holder('owner'), null::text, 'red'::text,
  r.name || ': renewal overdue since ' || to_char(r.renewal_date, 'DD Mon'),
  r.renewal_amount, 'clients'::text, r.client_id
from renewals r
where r.status = 'overdue' and r.stage in ('live', 'onboarding', 'paused')
union all
select
  'under_spend'::text, 'under_spend:' || c.client_id, c.client_id, null::uuid,
  app_role_holder('media_buyer'), null::text, 'amber'::text,
  c.name || ' spent $' || round(y.spend) || ' vs $' || round(g.target) || case when g.from_budget then ' budget' else ' 7-day average' end
    || ' on ' || to_char(k.local_date - 1, 'Dy DD Mon'),
  null::numeric, 'clients'::text, c.client_id
from clients_ads_trusted c
cross join lateral ad_account_clock(c.client_id) k
join ad_metrics_daily y on y.client_id = c.client_id and y.date = k.local_date - 1
cross join lateral (
  select
    coalesce(nullif(y.daily_budget, 0), a.avg7) as target,
    nullif(y.daily_budget, 0) is not null as from_budget
  from (
    select case when count(*) >= 4 then avg(d.spend) end as avg7
    from ad_metrics_daily d
    where d.client_id = c.client_id and d.date between k.local_date - 8 and k.local_date - 2
  ) a
) g
where c.stage = 'live'
  and (c.launch_date is null or c.launch_date < k.local_date - 1)
  and k.local_hour >= 12
  and y.synced_at >= (k.local_date::timestamp at time zone k.tz)
  and y.spend > 0
  and g.target > 0
  and y.spend < config_value('under_spend_ratio') * g.target;
grant select on exception_detections, exception_detections_core to authenticated, service_role;

insert into scoring_config (key, card, label, direction, green, amber, value, unit) values
  ('under_spend_ratio', 'ads', 'Under-spending: yesterday below this share of budget', 'constant', null, null, 0.6, 'x')
on conflict (key) do nothing;

insert into exception_rules (type, label, sources, urgent) values
  ('under_spend', 'Under-spending: yesterday under 60% of budget', '{cortana}', false)
on conflict (type) do nothing;
