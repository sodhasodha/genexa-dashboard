-- Genexa OS reads the client dashboard (11 Nov 2026).
--
-- The client dashboard is where clinics log every outcome (showed, no-show, closed, not closed) and the
-- revenue of each close, and it decides what a clinic owes: an outcome still Booked 24h after the
-- appointment, or a close with no revenue. Genexa OS used to work these out itself from Cortana events
-- and its own copy of GHL appointments, and disagreed (118 outcomes "overdue" against the dashboard's 35;
-- October revenue off by thousands at several clinics). Now:
--
--   * client-dashboard-sync (every 10 minutes) copies each clinic's patients from the dashboard's
--     /api/agent/export into dashboard_patients (first names only, read only; nothing is written back).
--   * outcome_events is cortana_events with, for each clinic on the dashboard from the day its tracking
--     starts, shows, no-shows and paid closes taken from the dashboard instead of Cortana. Every revenue,
--     close and show figure (daily and monthly performance, ROAS, client reports, rev share billing)
--     reads it. Leads and bookings still come from Cortana.
--   * outcomes_owed is what each clinic owes: the dashboard's list for clinics on it, the old
--     appointments rule for clinics that are not. The amber flag, the Monday clinic nudge, Data review
--     and client reports all read it.

create table dashboard_clinics (
  dashboard_clinic_id uuid primary key,
  client_id uuid references clients(id),
  name text not null,
  ghl_location_id text,
  timezone text not null default 'America/New_York',
  rev_share_pct numeric(5,2),
  -- the dashboard only tracks appointments from this day (clinic time); before it, Cortana still counts
  tracking_from date,
  patients integer,
  outstanding integer,
  outcomes_overdue integer,
  closes_missing_revenue integer,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger dashboard_clinics_set_updated_at before update on dashboard_clinics for each row execute function set_updated_at();
create trigger dashboard_clinics_forbid_delete before delete on dashboard_clinics for each row execute function forbid_delete();

create table dashboard_patients (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  dashboard_clinic_id uuid not null references dashboard_clinics(dashboard_clinic_id),
  contact_id text not null,
  opportunity_id text,
  first_name text,
  stage text not null check (stage in ('appointments_booked', 'showed', 'no_show', 'closed_won', 'not_closed', 'repeat_purchase')),
  consult_at timestamptz,
  appointment_cancelled boolean not null default false,
  sort_at timestamptz,
  revenue numeric(12,2) not null default 0,
  -- the day the clinic said it was paid (logged on the dashboard), if it said
  purchase_date date,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- no longer on the dashboard (opportunity moved out of the patient stages)
  gone_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, contact_id)
);
create index dashboard_patients_client_idx on dashboard_patients (client_id) where gone_at is null;
create trigger dashboard_patients_set_updated_at before update on dashboard_patients for each row execute function set_updated_at();
create trigger dashboard_patients_forbid_delete before delete on dashboard_patients for each row execute function forbid_delete();

alter table dashboard_clinics enable row level security;
alter table dashboard_patients enable row level security;
-- Read like cortana_events: any staff member (CSRs are not staff here).
create policy owner_all on dashboard_clinics for all to authenticated using (app_is_owner()) with check (app_is_owner());
create policy staff_read on dashboard_clinics for select to authenticated using (app_staff_id() is not null);
create policy owner_all on dashboard_patients for all to authenticated using (app_is_owner()) with check (app_is_owner());
create policy staff_read on dashboard_patients for select to authenticated using (app_staff_id() is not null);
revoke all on dashboard_clinics, dashboard_patients from anon;
grant select on dashboard_clinics, dashboard_patients to authenticated;
grant select, insert, update on dashboard_clinics, dashboard_patients to service_role;

update integration_sync_status set schedule_minutes = 10 where source = 'client_dashboard';

-- Clinics whose outcomes come from the dashboard, and from when (start of the tracking day, clinic time).
create view dashboard_connected with (security_invoker = true) as
select d.client_id, coalesce(d.tracking_from::timestamp at time zone d.timezone, '-infinity'::timestamptz) as from_at
from dashboard_clinics d
where d.client_id is not null and d.last_success_at is not null;

-- cortana_events, with shows, no-shows and paid closes from the dashboard where it is the source.
-- A paid close counts on the day the clinic said it was paid (noon ET), else on its appointment.
create view outcome_events with (security_invoker = true) as
select e.client_id, e.contact_id, e.event, e.occurred_at, e.value, e.is_test
from cortana_events e
where not (e.event in ('purchase', 'appointment_shown', 'appointment_no_show')
  and exists (select 1 from dashboard_connected d where d.client_id = e.client_id and e.occurred_at >= d.from_at))
union all
select p.client_id, 'dashboard:' || p.contact_id, x.event, x.at, x.value, false
from dashboard_patients p
join dashboard_connected d on d.client_id = p.client_id
cross join lateral (values
  (case when p.stage in ('showed', 'closed_won', 'not_closed') then 'appointment_shown' when p.stage = 'no_show' then 'appointment_no_show' end,
   p.consult_at, null::numeric(12,2)),
  (case when p.stage = 'closed_won' and p.revenue > 0 then 'purchase' end,
   coalesce((p.purchase_date + time '12:00') at time zone 'America/New_York', p.consult_at, p.sort_at), p.revenue)
) as x(event, at, value)
where p.gone_at is null and x.event is not null and x.at is not null and x.at >= d.from_at;
grant select on dashboard_connected, outcome_events to authenticated, service_role;

-- What each clinic owes. On the dashboard: an outcome still Booked 24h after the appointment (not
-- cancelled), or a close with no revenue, exactly the dashboard's rules. Elsewhere: GHL appointments
-- with no outcome 24h after the consult, as before.
create view outcomes_owed with (security_invoker = true) as
select p.id, p.client_id,
  case when p.stage = 'closed_won' then 'missing_revenue' else 'overdue' end as kind,
  p.first_name, p.consult_at, 'dashboard'::text as source, 'dashboard_patients'::text as record_table
from dashboard_patients p
join dashboard_connected d on d.client_id = p.client_id
where p.gone_at is null and (
  (p.stage = 'appointments_booked' and p.consult_at is not null and not p.appointment_cancelled and p.consult_at < now() - interval '24 hours')
  or (p.stage = 'closed_won' and p.revenue <= 0))
union all
select a.id, a.client_id, 'overdue', a.contact_first_name, a.scheduled_for, 'appointments', 'appointments'
from appointments a
left join leads l on l.id = a.lead_id
where a.attendance = 'scheduled' and coalesce(l.is_test, false) = false and a.scheduled_for < now() - interval '24 hours'
  and a.client_id not in (select d.client_id from dashboard_connected d);
grant select on outcomes_owed to authenticated, service_role;

create or replace view client_performance_daily with (security_invoker = true) as
WITH ads AS (
         SELECT ad_metrics_daily.client_id,
            ad_metrics_daily.date AS day,
            ad_metrics_daily.spend,
            ad_metrics_daily.impressions,
            ad_metrics_daily.clicks,
            ad_metrics_daily.page_views,
            ad_metrics_daily.unique_visitors
           FROM ad_metrics_daily
        ), ev AS (
         SELECT e.client_id,
            app_day(e.occurred_at) AS day,
            count(DISTINCT e.contact_id) FILTER (WHERE e.event = 'lead'::text) AS leads,
            count(DISTINCT e.contact_id) FILTER (WHERE e.event = 'unconfirmed_appointment_booked'::text) AS booked,
            count(DISTINCT e.contact_id) FILTER (WHERE e.event = 'appointment_booked'::text) AS confirmed,
            count(DISTINCT e.contact_id) FILTER (WHERE e.event = 'appointment_shown'::text) AS shows,
            count(DISTINCT e.contact_id) FILTER (WHERE e.event = 'appointment_no_show'::text) AS no_shows,
            count(DISTINCT e.contact_id) FILTER (WHERE e.event = 'appointment_cancelled'::text) AS cancelled,
            count(*) FILTER (WHERE e.event = 'purchase'::text) AS closes,
            sum(e.value) FILTER (WHERE e.event = 'purchase'::text) AS revenue
           FROM outcome_events e
          WHERE NOT e.is_test
          GROUP BY e.client_id, (app_day(e.occurred_at))
        ), keys AS (
         SELECT ads_1.client_id,
            ads_1.day
           FROM ads ads_1
        UNION
         SELECT ev_1.client_id,
            ev_1.day
           FROM ev ev_1
        )
 SELECT k.client_id,
    k.day,
    ads.spend,
    ads.impressions,
    ads.clicks,
    ads.page_views,
    ads.unique_visitors,
    COALESCE(ev.leads, 0::bigint) AS leads,
    COALESCE(ev.booked, 0::bigint) AS booked,
    COALESCE(ev.confirmed, 0::bigint) AS confirmed,
    COALESCE(ev.shows, 0::bigint) AS shows,
    COALESCE(ev.no_shows, 0::bigint) AS no_shows,
    COALESCE(ev.cancelled, 0::bigint) AS cancelled,
    COALESCE(ev.closes, 0::bigint) AS closes,
    ev.revenue,
    ads.spend / NULLIF(ev.leads, 0)::numeric AS cpl,
    ads.spend / NULLIF(ev.booked, 0)::numeric AS cost_per_booked,
    ev.leads::numeric / NULLIF(ads.unique_visitors, 0)::numeric AS lp_conversion_rate,
    ev.booked::numeric / NULLIF(ev.leads, 0)::numeric AS booking_rate,
    ev.confirmed::numeric / NULLIF(ev.booked, 0)::numeric AS confirmation_rate,
    ev.shows::numeric / NULLIF(ev.shows + ev.no_shows, 0)::numeric AS show_rate,
    ev.closes::numeric / NULLIF(ev.shows, 0)::numeric AS close_rate
   FROM keys k
     LEFT JOIN ads ON ads.client_id = k.client_id AND ads.day = k.day
     LEFT JOIN ev ON ev.client_id = k.client_id AND ev.day = k.day
  WHERE NOT (k.client_id IN ( SELECT clients_ads_unverified.client_id
           FROM clients_ads_unverified));

create or replace view client_monthly with (security_invoker = true) as
WITH ads AS (
         SELECT client_performance_daily.client_id,
            date_trunc('month'::text, client_performance_daily.day::timestamp with time zone)::date AS month,
            sum(client_performance_daily.spend) AS spend,
            sum(client_performance_daily.impressions) AS impressions,
            sum(client_performance_daily.clicks) AS clicks,
            sum(client_performance_daily.page_views) AS page_views,
            sum(client_performance_daily.unique_visitors) AS unique_visitors
           FROM client_performance_daily
          GROUP BY client_performance_daily.client_id, (date_trunc('month'::text, client_performance_daily.day::timestamp with time zone)::date)
        ), ev AS (
         SELECT e.client_id,
            date_trunc('month'::text, app_day(e.occurred_at)::timestamp with time zone)::date AS month,
            count(DISTINCT e.contact_id) FILTER (WHERE e.event = 'lead'::text) AS leads,
            count(DISTINCT e.contact_id) FILTER (WHERE e.event = 'unconfirmed_appointment_booked'::text) AS booked,
            count(DISTINCT e.contact_id) FILTER (WHERE e.event = 'appointment_booked'::text) AS confirmed,
            count(DISTINCT e.contact_id) FILTER (WHERE e.event = 'appointment_shown'::text) AS shows,
            count(DISTINCT e.contact_id) FILTER (WHERE e.event = 'appointment_no_show'::text) AS no_shows,
            count(DISTINCT e.contact_id) FILTER (WHERE e.event = 'appointment_cancelled'::text) AS cancelled,
            count(*) FILTER (WHERE e.event = 'purchase'::text) AS closes,
            sum(e.value) FILTER (WHERE e.event = 'purchase'::text) AS revenue
           FROM outcome_events e
          WHERE NOT e.is_test AND NOT (e.client_id IN ( SELECT u.client_id
                   FROM clients_ads_unverified u))
          GROUP BY e.client_id, (date_trunc('month'::text, app_day(e.occurred_at)::timestamp with time zone)::date)
        ), m AS (
         SELECT COALESCE(ads.client_id, ev.client_id) AS client_id,
            COALESCE(ads.month, ev.month) AS month,
            ads.spend,
            ads.impressions,
            ads.clicks,
            ads.page_views,
            ads.unique_visitors,
            COALESCE(ev.leads, 0::bigint)::numeric AS leads,
            COALESCE(ev.booked, 0::bigint)::numeric AS booked,
            COALESCE(ev.confirmed, 0::bigint)::numeric AS confirmed,
            COALESCE(ev.shows, 0::bigint)::numeric AS shows,
            COALESCE(ev.no_shows, 0::bigint)::numeric AS no_shows,
            COALESCE(ev.cancelled, 0::bigint)::numeric AS cancelled,
            COALESCE(ev.closes, 0::bigint)::numeric AS closes,
            ev.revenue
           FROM ads
             FULL JOIN ev ON ev.client_id = ads.client_id AND ev.month = ads.month
        )
 SELECT client_id,
    month,
    spend,
    impressions,
    clicks,
    page_views,
    unique_visitors,
    leads,
    booked,
    confirmed,
    shows,
    no_shows,
    cancelled,
    closes,
    revenue,
    spend / NULLIF(leads, 0::numeric) AS cpl,
    spend / NULLIF(booked, 0::numeric) AS cost_per_booked,
    leads / NULLIF(unique_visitors, 0::numeric) AS lp_conversion_rate,
    booked / NULLIF(leads, 0::numeric) AS booking_rate,
    confirmed / NULLIF(booked, 0::numeric) AS confirmation_rate,
    shows / NULLIF(shows + no_shows, 0::numeric) AS show_rate,
    closes / NULLIF(shows, 0::numeric) AS close_rate,
    clicks / NULLIF(impressions, 0::numeric) AS ctr,
    revenue / NULLIF(spend, 0::numeric) AS roas,
    revenue * config_value('rev_share_rate'::text) AS rev_share
   FROM m;

CREATE OR REPLACE FUNCTION public.client_funnel_period(p_from date, p_to date)
 RETURNS TABLE(client_id uuid, leads bigint, booked bigint, confirmed bigint, shows bigint, no_shows bigint, cancelled bigint, closes bigint, revenue numeric)
 LANGUAGE sql
 STABLE
AS $function$
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
  from outcome_events e
  where not e.is_test
    and app_day(e.occurred_at) between p_from and p_to
    and e.client_id not in (select u.client_id from clients_ads_unverified u)
  group by e.client_id
$function$;

CREATE OR REPLACE FUNCTION public.rev_share_period(p_from date, p_to date)
 RETURNS TABLE(client_id uuid, name text, rev_share_type text, terms text, revenue numeric, new_patients bigint, owed numeric)
 LANGUAGE sql
 STABLE
AS $function$
  with firsts as (
    select e.client_id, e.contact_id, min(e.occurred_at) as first_at
    from outcome_events e
    where not e.is_test and e.event = 'purchase'
    group by e.client_id, e.contact_id
  ),
  p as (
    select c.id as client_id, c.name, c.rev_share_type,
      coalesce(c.rev_share_rate, config_value('rev_share_rate')) as rate, c.rev_share_per_patient as per_patient,
      (select coalesce(sum(e.value), 0) from outcome_events e
        where e.client_id = c.id and not e.is_test and e.event = 'purchase' and app_day(e.occurred_at) between p_from and p_to) as revenue,
      (select count(*) from firsts f where f.client_id = c.id and app_day(f.first_at) between p_from and p_to) as new_patients
    from clients c
    where c.deleted_at is null and c.id not in (select u.client_id from clients_ads_unverified u)
  )
  select p.client_id, p.name, p.rev_share_type,
    case p.rev_share_type
      when 'none' then 'No rev share'
      when 'per_patient' then '$' || trim(to_char(p.per_patient, 'FM999,999,990.##'), '.') || ' per new paying patient'
      else trim(to_char(p.rate * 100, 'FM990.##'), '.') || '% of clinic revenue'
    end,
    p.revenue, p.new_patients,
    round(case p.rev_share_type when 'none' then 0 when 'per_patient' then p.new_patients * p.per_patient else p.revenue * p.rate end, 2)
  from p
  where p.revenue > 0 or p.new_patients > 0
$function$;

CREATE OR REPLACE FUNCTION public.client_report(p_from date, p_to date)
 RETURNS TABLE(client_id uuid, name text, launch_date date, spend numeric, leads numeric, booked numeric, shows numeric, closes numeric, revenue numeric, roas numeric, status text, reasons text[], roas_bad boolean)
 LANGUAGE sql
 STABLE
AS $function$
  with c as (
    select cl.id, cl.name, cl.launch_date, cl.cortana_business_id is not null as connected,
      exists (select 1 from clients_ads_unverified u where u.client_id = cl.id) as unverified
    from clients cl
    where cl.deleted_at is null and cl.stage = 'live'
  ),
  stale as (select coalesce(bool_or(f.is_stale), false) as cortana_stale from source_freshness f where f.source = 'cortana'),
  m as (
    select c.*,
      (select sum(d.spend) from ad_metrics_daily d where d.client_id = c.id and d.date between p_from and p_to) as spend,
      f.leads, f.booked, f.shows, f.closes, f.revenue,
      (select count(*) from outcome_events e where e.client_id = c.id and not e.is_test and e.event = 'purchase'
         and coalesce(e.value, 0) = 0 and app_day(e.occurred_at) between p_from and p_to)
       + (select count(*) from outcomes_owed o where o.client_id = c.id and o.kind = 'missing_revenue'
         and app_day(o.consult_at) between p_from and p_to) as closes_without_amount,
      (select count(*) from outcomes_owed o where o.client_id = c.id and o.kind = 'overdue'
         and app_day(o.consult_at) between p_from and p_to) as unlogged
    from c
    left join client_funnel_period(p_from, p_to) f on f.client_id = c.id
  ),
  r as (
    select m.*, s.cortana_stale,
      array_remove(array[
        case when not m.connected then 'Not connected to Cortana' end,
        case when m.unverified then 'Ad numbers unverified' end,
        case when m.connected and not m.unverified and coalesce(m.spend, 0) = 0 then 'No ad spend in this range' end,
        case when s.cortana_stale then 'Cortana has not synced recently' end
      ], null) as stop,
      array_remove(array[
        case when p_to >= app_today() then 'Range includes today: numbers are still coming in' end,
        case when m.launch_date is not null and m.launch_date > p_from then 'Launched ' || to_char(m.launch_date, 'DD Mon') || ', part way through the range' end,
        case when m.unlogged > 0 then m.unlogged || ' consult' || case when m.unlogged = 1 then '' else 's' end || ' with no outcome logged' end,
        case when m.closes_without_amount > 0 then m.closes_without_amount || ' close' || case when m.closes_without_amount = 1 then '' else 's' end || ' with no amount' end,
        case when coalesce(m.spend, 0) > 0 and coalesce(m.revenue, 0) / m.spend < config_value('roas_red_below') then 'ROAS under ' || trim(to_char(config_value('roas_red_below'), 'FM990.##'), '.') || 'x' end
      ], null) as check_reasons
    from m cross join stale s
  )
  select r.id, r.name, r.launch_date,
    r.spend, coalesce(r.leads, 0)::numeric, coalesce(r.booked, 0)::numeric, coalesce(r.shows, 0)::numeric, coalesce(r.closes, 0)::numeric,
    coalesce(r.revenue, 0), coalesce(r.revenue, 0) / nullif(r.spend, 0),
    case when cardinality(r.stop) > 0 then 'dont_send' when cardinality(r.check_reasons) > 0 then 'check' else 'good' end,
    r.stop || r.check_reasons,
    coalesce(r.spend, 0) > 0 and coalesce(r.revenue, 0) / r.spend < config_value('roas_red_below')
  from r
  order by case when cardinality(r.stop) > 0 then 2 when cardinality(r.check_reasons) > 0 then 1 else 0 end, r.name
$function$;

create or replace view client_health_reasons with (security_invoker = true) as
WITH stale AS (
         SELECT COALESCE(array_agg(source_freshness.source), '{}'::text[]) AS sources
           FROM source_freshness
          WHERE source_freshness.is_stale
        ), live AS (
         SELECT c.id,
            c.name,
            c.contact_name,
            c.cortana_business_id,
            c.ghl_location_id,
            c.whop_customer_ids,
            c.stage,
            c.pod,
            c.owner_id,
            c.billing_cycle,
            c.launch_date,
            c.guarantee_text,
            c.guarantee_target_amount,
            c.guarantee_deadline,
            c.next_action,
            c.last_contact_us,
            c.last_reply_client,
            c.slack_general_id,
            c.slack_scheduling_id,
            c.drive_url,
            c.kickoff_url,
            c.fathom_url,
            c.closer_notes,
            c.billing_notes,
            c.contract_status,
            c.ob_form_status,
            c.ob_call_date,
            c.onboarding_status,
            c.churn_date,
            c.churn_reason,
            c.legacy_ref,
            c.legacy_last_payment_date,
            c.legacy_total_paid,
            c.deleted_at,
            c.created_at,
            c.updated_at,
            c.cycle_fee,
            c.monthly_fee
           FROM clients c
          WHERE c.deleted_at IS NULL AND c.stage <> 'churned'::text
        ), r AS (
         SELECT d.client_id,
            'red'::text AS severity,
            'zero_spend'::text AS rule,
            '$0 ad spend 24h+'::text AS reason,
            ARRAY['cortana'::text] AS sources
           FROM exception_detections_core d
          WHERE d.type = 'zero_spend'::text
        UNION ALL
         SELECT rn.client_id,
            'red'::text,
            'renewal_overdue'::text,
            'Renewal overdue since '::text || to_char(rn.renewal_date::timestamp with time zone, 'DD Mon'::text),
            ARRAY['whop'::text] AS "array"
           FROM renewals rn
          WHERE rn.status = 'overdue'::text
        UNION ALL
         SELECT l.client_id,
            score_colour('health_paid_not_launched_days'::text, s.days_waiting_since_paid::numeric) AS score_colour,
            'paid_not_launched'::text,
            ('Paid '::text || s.days_waiting_since_paid) || ' days ago, not launched'::text,
            ARRAY[]::text[] AS "array"
           FROM launches l
             JOIN launch_sla s ON s.launch_id = l.id
          WHERE l.live_at IS NULL AND s.days_waiting_since_paid IS NOT NULL
        UNION ALL
         SELECT c.id,
            score_colour('health_no_reply_days'::text, (app_today() - app_day(c.last_reply_client))::numeric) AS score_colour,
            'no_reply'::text,
            ('No client reply for '::text || (app_today() - app_day(c.last_reply_client))) || ' days'::text,
            ARRAY[]::text[] AS "array"
           FROM live c
          WHERE c.stage = 'live'::text AND c.last_reply_client IS NOT NULL
        UNION ALL
         SELECT c.id,
                CASE
                    WHEN score_colour('cost_per_booked_7d'::text, w.spend / w.booked) = 'red'::text AND (c.launch_date IS NULL OR (app_today() - c.launch_date)::numeric < config_value('health_cpb_grace_days'::text)) THEN 'amber'::text
                    ELSE score_colour('cost_per_booked_7d'::text, w.spend / w.booked)
                END AS score_colour,
            'cost_per_booked'::text,
            '7d cost per booked $'::text || round(w.spend / w.booked),
            ARRAY['cortana'::text] AS "array"
           FROM live c
             JOIN LATERAL ( SELECT ( SELECT sum(d.spend) AS sum
                           FROM ad_metrics_daily d
                          WHERE d.client_id = c.id AND d.date >= (app_today() - 7) AND d.date <= (app_today() - 1)) AS spend,
                    ( SELECT sum(p.booked) AS sum
                           FROM client_performance_daily p
                          WHERE p.client_id = c.id AND p.day >= (app_today() - 7) AND p.day <= (app_today() - 1)) AS booked) w ON true
          WHERE c.stage = 'live'::text AND w.booked > 0::numeric AND w.spend IS NOT NULL AND NOT (c.id IN ( SELECT clients_ads_unverified.client_id
                   FROM clients_ads_unverified))
        UNION ALL
         SELECT o.client_id,
            'amber'::text,
            'outcomes_overdue'::text,
            CASE WHEN o.source = 'dashboard' THEN
              (count(*) FILTER (WHERE o.kind = 'overdue')) || ' outcomes overdue'
              || CASE WHEN count(*) FILTER (WHERE o.kind = 'missing_revenue') > 0 THEN ', ' || (count(*) FILTER (WHERE o.kind = 'missing_revenue')) || ' closes missing revenue' ELSE '' END
              || ' on the client dashboard'
            ELSE count(*) || ' outcomes overdue 48h+' END,
            ARRAY[CASE WHEN o.source = 'dashboard' THEN 'client_dashboard' ELSE 'ghl' END] AS "array"
           FROM outcomes_owed o
          WHERE o.source = 'dashboard' OR o.consult_at < (now() - config_value('health_outcomes_overdue_hours'::text)::double precision * '01:00:00'::interval)
          GROUP BY o.client_id, o.source
        UNION ALL
         SELECT c.id,
            'red'::text,
            'guarantee'::text,
            (((('Guarantee due '::text || to_char(c.guarantee_deadline::timestamp with time zone, 'DD Mon'::text)) || ': $'::text) || round(COALESCE(g.revenue, 0::numeric))) || ' of $'::text) || round(c.guarantee_target_amount),
            ARRAY['cortana'::text] AS "array"
           FROM live c
             JOIN LATERAL ( SELECT sum(p.revenue) AS revenue
                   FROM client_performance_daily p
                  WHERE p.client_id = c.id AND (c.launch_date IS NULL OR p.day >= c.launch_date)) g ON true
          WHERE c.guarantee_deadline IS NOT NULL AND c.guarantee_target_amount IS NOT NULL AND (c.guarantee_deadline - app_today()) >= 0 AND (c.guarantee_deadline - app_today())::numeric <= config_value('health_guarantee_window_days'::text) AND COALESCE(g.revenue, 0::numeric) < c.guarantee_target_amount
        )
 SELECT r.client_id,
    r.severity,
    r.rule,
    r.reason
   FROM r,
    stale
  WHERE (r.severity = ANY (ARRAY['red'::text, 'amber'::text])) AND NOT r.sources && stale.sources;

create or replace view outcome_nudges_due with (security_invoker = true) as
WITH oe AS (
         SELECT e.client_id,
            e.occurred_at,
            lower(split_part(btrim(e.contact_first_name), ' '::text, 1)) AS first_name
           FROM cortana_events e
          WHERE (e.event = ANY (ARRAY['appointment_shown'::text, 'appointment_no_show'::text, 'appointment_cancelled'::text])) AND e.occurred_at > (now() - '30 days'::interval)
        ), a AS (
         SELECT ap.client_id,
            ap.contact_key IS NOT NULL AND (EXISTS ( SELECT 1
                   FROM cortana_events e
                  WHERE e.client_id = ap.client_id AND e.contact_key = ap.contact_key)) AND NOT (EXISTS ( SELECT 1
                   FROM oe
                  WHERE oe.client_id = ap.client_id AND oe.occurred_at > (ap.scheduled_for - '12:00:00'::interval) AND oe.first_name = lower(split_part(btrim(ap.contact_first_name), ' '::text, 1)))) AND (EXISTS ( SELECT 1
                   FROM oe
                  WHERE oe.client_id = ap.client_id)) AS definite
           FROM appointments ap
          WHERE ap.attendance = 'scheduled'::text AND ap.scheduled_for < (now() - '24:00:00'::interval) AND ap.scheduled_for > (now() - '30 days'::interval)
            AND NOT (ap.client_id IN (SELECT d.client_id FROM dashboard_connected d))
        UNION ALL
         SELECT o.client_id, true AS definite
           FROM outcomes_owed o
          WHERE o.source = 'dashboard' AND o.kind = 'overdue'
        )
 SELECT cl.id AS client_id,
    cl.name,
    cl.slack_general_id AS channel,
    COALESCE(cl.timezone, 'America/New_York'::text) AS timezone,
    EXTRACT(hour FROM (now() AT TIME ZONE COALESCE(cl.timezone, 'America/New_York'::text)))::integer AS local_hour,
    EXTRACT(isodow FROM (now() AT TIME ZONE COALESCE(cl.timezone, 'America/New_York'::text)))::integer AS local_dow,
    (now() AT TIME ZONE COALESCE(cl.timezone, 'America/New_York'::text))::date AS local_date,
    count(*) FILTER (WHERE a.definite)::integer AS overdue_count,
    count(*) FILTER (WHERE NOT a.definite)::integer AS uncertain_count,
    COALESCE(NULLIF(cl.outcome_link, ''::text), ( SELECT NULLIF(app_settings.value #>> '{}'::text[], ''::text) AS "nullif"
           FROM app_settings
          WHERE app_settings.key = 'client_outcome_link'::text)) AS link
   FROM clients cl
     JOIN a ON a.client_id = cl.id
  WHERE cl.deleted_at IS NULL AND cl.stage = 'live'::text
  GROUP BY cl.id, cl.name, cl.slack_general_id, cl.timezone, cl.outcome_link;

create or replace view data_review_open with (security_invoker = true) as
WITH items AS (
         SELECT i.kind,
            i.record_table,
            i.record_id,
            i.client_id,
            i.title,
            i.detail,
            i.occurred_at
           FROM data_review_items i
          WHERE NOT (i.kind = 'anomaly'::text AND i.title ~~ '%fee on record%'::text) AND i.kind <> 'unlogged_outcome'::text
        UNION ALL
         SELECT 'unlogged_outcome'::text,
            o.record_table,
            o.id,
            o.client_id,
            (COALESCE(o.first_name, 'Patient'::text) || ' · '::text) || c.name,
            CASE WHEN o.kind = 'missing_revenue' THEN 'Closed on the client dashboard with no revenue entered'::text
              ELSE ('Consult '::text || to_char((o.consult_at AT TIME ZONE 'America/New_York'::text), 'Dy DD Mon HH24:MI'::text)) || ' ET, no outcome logged'::text END,
            COALESCE(o.consult_at, now())
           FROM outcomes_owed o
             JOIN clients c ON c.id = o.client_id
          WHERE o.source = 'dashboard' OR o.consult_at > (now() - '30 days'::interval)
        UNION ALL
         SELECT 'anomaly'::text,
            'client_fees'::text,
            f.client_id,
            f.client_id,
            ((((f.name || ' · fee on record '::text) || COALESCE(('$'::text || f.record_monthly) || '/month'::text, 'missing'::text)) || ', Whop charges $'::text) || f.whop_monthly) || '/month'::text,
            ('Whop: '::text || f.whop_plans) || '. MRR uses the Whop figure until you confirm one.'::text,
            now() AS now
           FROM client_fees f
          WHERE f.mismatch
        UNION ALL
         SELECT 'unclassified_payment'::text,
            'payments'::text,
            p.id,
            p.client_id,
            (COALESCE(c.name, p.customer_name, 'Unknown customer'::text) || ' · $'::text) || p.amount,
            ('Paid '::text || to_char((p.paid_at AT TIME ZONE 'America/New_York'::text), 'DD Mon'::text)) || ' with no Whop product. Not counted as cash collected until you say what it was.'::text,
            p.paid_at
           FROM payments p
             LEFT JOIN clients c ON c.id = p.client_id
          WHERE p.status = 'paid'::text AND NOT p.classified
        )
 SELECT kind,
    record_table,
    record_id,
    client_id,
    title,
    detail,
    occurred_at,
    (((kind || ':'::text) || record_id) || ':'::text) || md5(title) AS item_key
   FROM items
  WHERE NOT (EXISTS ( SELECT 1
           FROM data_review_dismissals d
          WHERE d.item_key = ((((items.kind || ':'::text) || items.record_id) || ':'::text) || md5(items.title))));
