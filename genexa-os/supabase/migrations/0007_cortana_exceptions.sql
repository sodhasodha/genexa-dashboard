-- Phase 2: Cortana window metrics and the exceptions engine.

-- ---------------------------------------------------------------------------
-- Cortana source tables
-- ---------------------------------------------------------------------------
alter table ad_metrics_daily add column reach bigint;
alter table ad_metrics_daily add column campaigns_in_scope integer;
alter table ad_metrics_ad_daily add column clicks bigint;
alter table ad_metrics_ad_daily add column reach bigint;

-- Per-ad totals over a rolling window, as Cortana reports them for that window.
-- Frequency and reach cannot be added up from daily rows, so 7-day frequency
-- has to come from a 7-day request.
create table ad_metrics_ad_window (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  ad_id text not null,
  period text not null check (period in ('3d', '7d', 'all')),
  ad_name text,
  ad_status text,
  window_start date not null,
  window_end date not null,
  spend numeric(12,2),
  impressions bigint,
  clicks bigint,
  reach bigint,
  ctr numeric,
  frequency numeric,
  leads integer,
  booked integer,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, ad_id, period)
);

-- One row per rule the engine evaluates. sources = the integrations the rule
-- reads; if any of them is stale the rule neither opens nor resolves anything.
create table exception_rules (
  id uuid primary key default gen_random_uuid(),
  type text not null unique,
  label text not null,
  sources text[] not null default '{}',
  enabled boolean not null default true,
  urgent boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['ad_metrics_ad_window', 'exception_rules'] loop
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', t || '_set_updated_at', t);
    execute format('create trigger %I before delete on %I for each row execute function forbid_delete()', t || '_forbid_delete', t);
    execute format('alter table %I enable row level security', t);
    execute format('create policy owner_all on %I for all to authenticated using (app_is_owner()) with check (app_is_owner())', t);
    execute format('create policy staff_read on %I for select to authenticated using (app_staff_id() is not null)', t);
    execute format('grant select, insert, update on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;
create trigger exception_rules_audit after insert or update on exception_rules
  for each row execute function audit_row();

insert into scoring_config (key, card, label, direction, green, amber, value, unit) values
  ('ad_fatigue_frequency',     'ads', 'Ad fatigue: 7d frequency above',                   'constant', null, null, 3,   'x'),
  ('ad_fatigue_ctr_drop_pct',  'ads', 'Ad fatigue: 7d CTR down vs all-time by',           'constant', null, null, 30,  '%'),
  ('ad_spend_no_booking',      'ads', 'Ad flagged: spent this much with 0 bookings',      'constant', null, null, 150, '$'),
  ('ad_spend_cpb_check',       'ads', 'Ad flagged: cost per booked checked after spend',  'constant', null, null, 250, '$'),
  ('ad_cpb_max',               'ads', 'Ad flagged: cost per booked above',                'constant', null, null, 150, '$'),
  ('ad_min_leads_for_rate',    'ads', 'Ad flagged: booking rate checked after leads',     'constant', null, null, 10,  'leads'),
  ('ad_min_booking_rate_pct',  'ads', 'Ad flagged: booking rate below',                   'constant', null, null, 25,  '%')
on conflict (key) do nothing;

insert into exception_rules (type, label, sources, urgent) values
  ('zero_spend',          'Live client, $0 spend 24h+',                     '{cortana}', true),
  ('account_cpb_high',    'Account 7d cost per booked over the red line',   '{cortana,ghl}', false),
  ('ad_fatigue',          'Ad fatigue: 7d frequency or CTR drop',           '{cortana}', false),
  ('ad_performance',      'Ad spending without bookings',                   '{cortana}', false),
  ('ad_disapproved',      'Disapproved ad',                                 '{cortana}', false),
  ('tech_job_overdue',    'Tech job past due (Genexa time)',                '{}', false),
  ('launch_sla_breached', 'Launch past 48h SLA',                            '{}', false),
  ('sla_pause_long',      'SLA paused more than 24h',                       '{}', false)
on conflict (type) do nothing;

-- The engine touches last_detected_at every 15 minutes; that is not a change to audit.
create or replace function audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_actor text;
  o jsonb;
  n jsonb;
  k text;
begin
  v_actor := coalesce(
    nullif(current_setting('app.actor', true), ''),
    (select name from staff where auth_user_id = auth.uid() limit 1),
    'system');
  n := to_jsonb(new);
  if tg_op = 'INSERT' then
    insert into audit_log (table_name, row_id, field, old_value, new_value, actor)
    values (tg_table_name, (n->>'id')::uuid, '_created', null, n::text, v_actor);
    return new;
  end if;
  o := to_jsonb(old);
  for k in select jsonb_object_keys(n) loop
    if k in ('updated_at', 'synced_at', 'last_detected_at') then continue; end if;
    if (o -> k) is distinct from (n -> k) then
      insert into audit_log (table_name, row_id, field, old_value, new_value, actor)
      values (tg_table_name, (n->>'id')::uuid, k, o ->> k, n ->> k, v_actor);
    end if;
  end loop;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Who owns what
-- ---------------------------------------------------------------------------
create function app_role_holder(p_role text) returns uuid
language sql stable security definer set search_path = public as $$
  select id from staff where role = p_role and status <> 'left' order by created_at limit 1
$$;

-- Clinics whose Cortana numbers can be trusted for alerts: connected, and the
-- campaign scope (if there is one) has been verified by a person.
create view clients_ads_trusted with (security_invoker = true) as
select c.id as client_id, c.name, c.stage, c.launch_date, c.cycle_fee,
  s.campaign_name_contains is not null as campaign_scoped
from clients c
left join client_campaign_scope s on s.client_id = c.id
where c.deleted_at is null
  and c.cortana_business_id is not null
  and coalesce(s.verified, true);

-- ---------------------------------------------------------------------------
-- Detections: one row per thing that is wrong right now.
-- ---------------------------------------------------------------------------
create view exception_detections with (security_invoker = true) as
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
-- Account 7d cost per booked over the red line. Spend: Cortana. Bookings: GHL.
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
    (select count(*) from leads l
      where l.client_id = c.client_id and not l.is_test
        and app_day(l.booked_at) between app_today() - 7 and app_today() - 1) as booked
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

-- ---------------------------------------------------------------------------
-- The engine. Opens, refreshes or auto-resolves by dedupe_key.
-- A rule whose source is stale is skipped entirely: it opens nothing and
-- resolves nothing, so stale data never looks like a problem or a fix.
-- ---------------------------------------------------------------------------
create function run_exceptions_engine()
returns table (exception_id uuid, action text, exception_type text)
language plpgsql security definer set search_path = public as $$
declare
  v_stale text[];
begin
  select coalesce(array_agg(f.source), '{}') into v_stale from source_freshness f where f.is_stale;

  drop table if exists _detections;
  create temp table _detections on commit drop as
  select distinct on (d.dedupe_key) d.*
  from exception_detections d
  join exception_rules r on r.type = d.type
  where r.enabled and not (r.sources && v_stale)
  order by d.dedupe_key;

  -- Snoozes that have run out come back as open.
  update exceptions e set status = 'open', snoozed_until = null
  where e.status = 'snoozed' and e.snoozed_until is not null and e.snoozed_until <= now();

  return query
  with u as (
    update exceptions e
    set last_detected_at = now(), reason = d.reason, money_at_risk = d.money_at_risk,
        severity = d.severity, owner_id = d.owner_id, owner_pod = d.owner_pod
    from _detections d
    where e.dedupe_key = d.dedupe_key and e.status in ('open', 'snoozed')
    returning e.id, e.type
  )
  select u.id, 'refreshed'::text, u.type from u;

  return query
  with i as (
    insert into exceptions (type, client_id, staff_id, owner_id, owner_pod, severity, reason,
                            money_at_risk, record_table, record_id, dedupe_key)
    select d.type, d.client_id, d.staff_id, d.owner_id, d.owner_pod, d.severity, d.reason,
           d.money_at_risk, d.record_table, d.record_id, d.dedupe_key
    from _detections d
    where not exists (
      select 1 from exceptions e where e.dedupe_key = d.dedupe_key and e.status in ('open', 'snoozed'))
    returning id, type
  )
  select i.id, 'opened'::text, i.type from i;

  return query
  with x as (
    update exceptions e
    set status = 'resolved', resolved_at = now(), resolved_by = 'system',
        resolution_note = 'Condition cleared'
    from exception_rules r
    where r.type = e.type and r.enabled and not (r.sources && v_stale)
      and e.status in ('open', 'snoozed')
      and not exists (select 1 from _detections d where d.dedupe_key = e.dedupe_key)
    returning e.id, e.type
  )
  select x.id, 'resolved'::text, x.type from x;
end $$;

revoke execute on function run_exceptions_engine() from public, anon, authenticated;
grant execute on function run_exceptions_engine() to service_role;
