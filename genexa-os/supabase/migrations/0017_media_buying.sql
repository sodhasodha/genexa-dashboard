-- Phase 4: Media Buying page.
--   media_account_metrics(days)  one row per connected clinic over a window
--   media_ad_metrics             one row per clinic + ad, 7d and all-time side by side, fatigue flag
--   score_media_weekly           the media buyer's scorecard
-- Every number is Cortana's (ad_metrics_* and cortana_events through client_performance_daily).
-- Every threshold is a scoring_config row.

insert into scoring_config (key, card, label, direction, green, amber, value, unit) values
  ('sop_milestone_1',           'ads',         'Ad SOP: first check on day',                        'constant', null, null, 3,  'days'),
  ('sop_milestone_2',           'ads',         'Ad SOP: second check on day',                       'constant', null, null, 7,  'days'),
  ('sop_milestone_3',           'ads',         'Ad SOP: third check on day',                        'constant', null, null, 10, 'days'),
  ('sop_milestone_4',           'ads',         'Ad SOP: fourth check on day',                       'constant', null, null, 14, 'days'),
  ('media_exception_sla_hours', 'media_buyer', 'Ad exception must be resolved within',              'constant', null, null, 24, 'hours'),
  ('media_flagged_days',        'media_buyer', 'Account counts as flagged after an exception open', 'constant', null, null, 3,  'days')
on conflict (key) do nothing;

-- "Day 4–6", or "Day 3" when the range is a single day.
create function sop_range_label(p_from int, p_to int) returns text
language sql immutable as $$
  select 'Day ' || p_from || case when p_to > p_from then '–' || p_to else '' end
$$;

-- Where an account is in the ad SOP, from days live. The milestone days are
-- scoring_config rows (3 / 7 / 10 / 14); the stages between them follow.
-- Null in (no launch date, or not launched yet) = null out.
create function sop_stage(p_days int) returns text
language sql stable as $$
  select case
    when p_days is null or p_days < 0 then null
    when p_days < m.a then sop_range_label(0, m.a - 1)
    when p_days = m.a then sop_range_label(m.a, m.a)
    when p_days < m.b then sop_range_label(m.a + 1, m.b - 1)
    when p_days = m.b then sop_range_label(m.b, m.b)
    when p_days < m.c then sop_range_label(m.b + 1, m.c - 1)
    when p_days = m.c then sop_range_label(m.c, m.c)
    when p_days < m.d then sop_range_label(m.c + 1, m.d - 1)
    when p_days = m.d then sop_range_label(m.d, m.d)
    else 'Day ' || (m.d + 1) || '+'
  end
  from (
    select config_value('sop_milestone_1')::int as a, config_value('sop_milestone_2')::int as b,
           config_value('sop_milestone_3')::int as c, config_value('sop_milestone_4')::int as d
  ) m
$$;

-- ---------------------------------------------------------------------------
-- Per account numbers over a window.
--   p_days = N    the last N complete ET days (ending yesterday)
--   p_days null   everything loaded
-- One row per non-churned clinic with a Cortana business. A clinic whose scope
-- is unverified is listed with unverified = true and no numbers.
-- Ratios are computed from the window's sums, never averaged from daily ratios.
-- Frequency cannot be summed from daily rows: impressions ÷ summed daily reach
-- is an approximation (a person reached on two days is counted twice).
-- The verdict is always the 7-day cost per booked, whatever window is asked for.
-- ---------------------------------------------------------------------------
create function media_account_metrics(p_days int default null)
returns table (
  client_id uuid, name text, stage text, launch_date date, days_live int, sop_stage text,
  unverified boolean, campaign_scoped boolean, window_from date, window_to date,
  spend numeric, impressions numeric, clicks numeric, reach numeric,
  leads numeric, booked numeric, shows numeric, closes numeric, revenue numeric,
  cpl numeric, cost_per_booked numeric, booking_rate numeric, cost_per_show numeric, cost_per_close numeric,
  frequency numeric, ctr numeric, cpm numeric,
  spend_7d numeric, booked_7d numeric, cost_per_booked_7d numeric, verdict text)
language sql stable as $$
  with c as (
    select cl.id, cl.name, cl.stage, cl.launch_date,
      exists (select 1 from clients_ads_unverified u where u.client_id = cl.id) as unverified,
      coalesce((select s.campaign_name_contains is not null from client_campaign_scope s where s.client_id = cl.id), false) as campaign_scoped
    from clients cl
    where cl.deleted_at is null and cl.stage <> 'churned' and cl.cortana_business_id is not null
  ),
  w as (
    select d.client_id, min(d.day) as first_day, max(d.day) as last_day,
      sum(d.spend) as spend, sum(d.impressions) as impressions, sum(d.clicks) as clicks,
      sum(d.leads) as leads, sum(d.booked) as booked, sum(d.shows) as shows, sum(d.closes) as closes, sum(d.revenue) as revenue
    from client_performance_daily d
    where p_days is null or d.day between app_today() - p_days and app_today() - 1
    group by d.client_id
  ),
  -- Reach is only on the ad rows; impressions are taken from the same rows so the two match.
  r as (
    select a.client_id, sum(a.impressions) as impressions, sum(a.reach) as reach
    from ad_metrics_daily a
    where a.reach is not null and a.impressions is not null
      and (p_days is null or a.date between app_today() - p_days and app_today() - 1)
    group by a.client_id
  ),
  s as (
    select d.client_id, sum(d.spend) as spend, sum(d.booked) as booked
    from client_performance_daily d
    where d.day between app_today() - 7 and app_today() - 1
    group by d.client_id
  )
  select
    c.id, c.name, c.stage, c.launch_date,
    (app_today() - c.launch_date)::int,
    sop_stage((app_today() - c.launch_date)::int),
    c.unverified, c.campaign_scoped,
    case when p_days is null then w.first_day else app_today() - p_days end,
    case when p_days is null then w.last_day else app_today() - 1 end,
    w.spend::numeric, w.impressions::numeric, w.clicks::numeric,
    case when c.unverified then null else r.reach::numeric end,
    w.leads::numeric, w.booked::numeric, w.shows::numeric, w.closes::numeric, w.revenue::numeric,
    w.spend / nullif(w.leads, 0),
    w.spend / nullif(w.booked, 0),
    w.booked::numeric / nullif(w.leads, 0),
    w.spend / nullif(w.shows, 0),
    w.spend / nullif(w.closes, 0),
    case when c.unverified then null else r.impressions::numeric / nullif(r.reach, 0) end,
    100.0 * w.clicks / nullif(w.impressions, 0),
    1000.0 * w.spend / nullif(w.impressions, 0),
    s.spend::numeric, s.booked::numeric,
    s.spend / nullif(s.booked, 0),
    score_colour('cost_per_booked_7d', s.spend / nullif(s.booked, 0))
  from c
  left join w on w.client_id = c.id
  left join r on r.client_id = c.id
  left join s on s.client_id = c.id
  order by c.name
$$;

-- ---------------------------------------------------------------------------
-- Per ad: Cortana's own 7-day and all-time window rows side by side.
-- Fatigue = 7d frequency over the line, or 7d CTR down by the configured share
-- against all-time. Null when neither test can be made.
-- Unverified clinics are left out. A clinic scoped by campaign name has no rows
-- here at all (Cortana's ad rows carry no campaign).
-- ---------------------------------------------------------------------------
create view media_ad_metrics with (security_invoker = true) as
with ids as (
  select distinct client_id, ad_id from ad_metrics_ad_window where period in ('7d', 'all')
),
j as (
  select
    i.client_id, c.name as client_name, i.ad_id,
    coalesce(w.ad_name, a.ad_name) as ad_name,
    coalesce(w.ad_status, a.ad_status) as ad_status,
    w.spend as spend_7d, w.leads as leads_7d, w.booked as booked_7d,
    w.impressions as impressions_7d, w.clicks as clicks_7d, w.frequency as frequency_7d, w.ctr as ctr_7d,
    a.spend as spend_all, a.leads as leads_all, a.booked as booked_all,
    a.impressions as impressions_all, a.clicks as clicks_all, a.frequency as frequency_all, a.ctr as ctr_all,
    greatest(w.synced_at, a.synced_at) as synced_at,
    config_value('ad_fatigue_frequency') as freq_line,
    config_value('ad_fatigue_ctr_drop_pct') as ctr_drop_pct
  from ids i
  join clients c on c.id = i.client_id and c.deleted_at is null
  left join ad_metrics_ad_window w on w.client_id = i.client_id and w.ad_id = i.ad_id and w.period = '7d'
  left join ad_metrics_ad_window a on a.client_id = i.client_id and a.ad_id = i.ad_id and a.period = 'all'
  where i.client_id not in (select client_id from clients_ads_unverified)
),
f as (
  select j.*,
    j.frequency_7d > j.freq_line as freq_high,
    case when j.ctr_all > 0 and j.ctr_7d is not null
      then j.ctr_7d <= j.ctr_all * (1 - j.ctr_drop_pct / 100.0) end as ctr_down
  from j
)
select
  f.client_id, f.client_name, f.ad_id, f.ad_name, f.ad_status,
  coalesce(f.ad_status = 'ACTIVE', false) as is_active,
  f.spend_7d, f.leads_7d, f.booked_7d, f.spend_7d / nullif(f.booked_7d, 0) as cost_per_booked_7d,
  f.impressions_7d, f.clicks_7d, f.frequency_7d, f.ctr_7d,
  f.spend_all, f.leads_all, f.booked_all, f.spend_all / nullif(f.booked_all, 0) as cost_per_booked_all,
  f.impressions_all, f.clicks_all, f.frequency_all, f.ctr_all,
  case when f.freq_high is null and f.ctr_down is null then null
    else coalesce(f.freq_high, false) or coalesce(f.ctr_down, false) end as fatigue,
  case
    when f.freq_high then '7d frequency ' || round(f.frequency_7d, 2) || ' is over ' || f.freq_line
    when f.ctr_down then '7d CTR ' || round(f.ctr_7d, 2) || '% vs ' || round(f.ctr_all, 2) || '% all-time (down ' || f.ctr_drop_pct || '% or more)'
  end as fatigue_reason,
  f.synced_at
from f;

-- ---------------------------------------------------------------------------
-- Media buyer scorecard, one row per media buyer, week and metric.
--   exceptions_24h_pct    ad exceptions first detected in the week that were resolved inside the SLA.
--                         Still open past the SLA = missed; still open inside it = not counted yet.
--   accounts_over_cpb     live, verified accounts whose 7d cost per booked is red.
--   book_cpb_change_pct   book-wide 7d cost per booked against the 7 days before (numerator = now, denominator = before).
--   zero_spend_accounts   live accounts with a zero-spend exception open.
--   accounts_flagged_3d   live accounts with an ad exception open for media_flagged_days or more.
-- The last four describe "right now" and are not stored, so past weeks have a null value.
-- A metric with nothing to measure (zero denominator) has a null value and a null colour.
-- ---------------------------------------------------------------------------
create view score_media_weekly with (security_invoker = true) as
with buyers as (
  select id as staff_id from staff where role = 'media_buyer' and status <> 'left'
),
weeks as (
  select g::date as week_start, g::date = app_week_start(app_today()) as is_current
  from generate_series(app_week_start(app_today()) - 84, app_week_start(app_today()), interval '7 day') g
),
ad_ex as (
  select e.id, e.type, e.client_id, e.status, e.first_detected_at, e.resolved_at,
    app_week_start(app_day(e.first_detected_at)) as week_start
  from exceptions e
  where e.type in ('zero_spend', 'account_cpb_high', 'ad_fatigue', 'ad_performance', 'ad_disapproved')
),
sla as (
  select x.week_start,
    count(*) filter (where x.status = 'resolved' and x.resolved_at <= x.first_detected_at + h.span) as hit,
    count(*) filter (where x.status = 'resolved' or x.first_detected_at + h.span < now()) as counted
  from ad_ex x
  cross join (select config_value('media_exception_sla_hours') * interval '1 hour' as span) h
  group by x.week_start
),
acc as (
  select m.client_id, m.verdict from media_account_metrics(7) m where m.stage = 'live' and not m.unverified
),
live as (
  select count(*)::numeric as n, (count(*) filter (where verdict = 'red'))::numeric as over_cpb from acc
),
book as (
  select
    (select sum(d.spend) / nullif(sum(d.booked), 0) from client_performance_daily d
      where d.day between app_today() - 7 and app_today() - 1) as cur,
    (select sum(d.spend) / nullif(sum(d.booked), 0) from client_performance_daily d
      where d.day between app_today() - 14 and app_today() - 8) as prev
),
open_ex as (
  select
    (count(distinct x.client_id) filter (where x.type = 'zero_spend'))::numeric as zero_spend,
    (count(distinct x.client_id) filter (
      where x.first_detected_at <= now() - config_value('media_flagged_days') * interval '1 day'))::numeric as flagged
  from ad_ex x
  join acc on acc.client_id = x.client_id
  where x.status in ('open', 'snoozed')
),
m as (
  select w.week_start, 'exceptions_24h_pct'::text as metric, 'media_exceptions_24h_pct'::text as config_key,
    case when coalesce(s.counted, 0) > 0 then round(100.0 * s.hit / s.counted, 1) end as value,
    coalesce(s.hit, 0)::numeric as numerator, coalesce(s.counted, 0)::numeric as denominator
  from weeks w left join sla s on s.week_start = w.week_start

  union all
  select w.week_start, 'accounts_over_cpb', 'media_accounts_over_cpb',
    case when w.is_current and l.n > 0 then l.over_cpb end,
    case when w.is_current then l.over_cpb end,
    case when w.is_current then l.n end
  from weeks w cross join live l

  union all
  select w.week_start, 'book_cpb_change_pct', 'media_book_cpb_change_pct',
    case when w.is_current then round(100.0 * (b.cur - b.prev) / nullif(b.prev, 0), 1) end,
    case when w.is_current then round(b.cur, 2) end,
    case when w.is_current then round(b.prev, 2) end
  from weeks w cross join book b

  union all
  select w.week_start, 'zero_spend_accounts', 'media_zero_spend_accounts',
    case when w.is_current and l.n > 0 then o.zero_spend end,
    case when w.is_current then o.zero_spend end,
    case when w.is_current then l.n end
  from weeks w cross join live l cross join open_ex o

  union all
  select w.week_start, 'accounts_flagged_3d', 'media_accounts_flagged_3d',
    case when w.is_current and l.n > 0 then o.flagged end,
    case when w.is_current then o.flagged end,
    case when w.is_current then l.n end
  from weeks w cross join live l cross join open_ex o
)
select
  b.staff_id,
  m.week_start,
  'media_buyer'::text as card,
  m.metric,
  m.value,
  m.numerator,
  m.denominator,
  score_colour(m.config_key, m.value) as colour
from buyers b
cross join m;

grant select on media_ad_metrics, score_media_weekly to authenticated;
grant all on media_ad_metrics, score_media_weekly to service_role;
revoke all on media_ad_metrics, score_media_weekly from anon;
