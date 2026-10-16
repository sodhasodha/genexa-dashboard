-- 1. A clinic sharing its ad account (campaigns left out by name) counts as
--    campaign-scoped too: its per-ad rows cannot be split, so none are shown.
create or replace function media_account_metrics(p_days int default null)
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
      coalesce((select s.campaign_name_contains is not null or s.campaign_name_excludes is not null from client_campaign_scope s where s.client_id = cl.id), false) as campaign_scoped
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

-- 2. The Clients page: one row per clinic to check daily. Health and its worst
--    reason, and the five numbers that say whether the ads pay: ad spend, ROAS,
--    cost per lead, cost per appointment booked, cost per close. Same figures as
--    Media Buying (media_account_metrics) for the same window.
create function client_health_board(p_days int default 7)
returns table (
  client_id uuid, name text, stage text, colour text, bottleneck text, reasons text,
  ads_state text, spend numeric, revenue numeric, roas numeric, cpl numeric, cost_per_booked numeric, cost_per_close numeric,
  leads numeric, booked numeric, closes numeric, window_from date, window_to date)
language sql stable as $$
  select
    c.id, c.name, c.stage, h.colour,
    -- Reasons come worst first: the first one is the main bottleneck.
    nullif(split_part(coalesce(h.reasons, ''), ' · ', 1), ''),
    h.reasons,
    case when c.cortana_business_id is null then 'not_connected' when m.unverified then 'unverified' else 'ok' end,
    m.spend, m.revenue, m.revenue / nullif(m.spend, 0), m.cpl, m.cost_per_booked, m.cost_per_close,
    m.leads, m.booked, m.closes, m.window_from, m.window_to
  from clients c
  left join client_health h on h.client_id = c.id
  left join media_account_metrics(p_days) m on m.client_id = c.id
  where c.deleted_at is null and c.stage <> 'churned'
  order by case h.colour when 'red' then 0 when 'amber' then 1 when 'green' then 2 else 3 end,
    case c.stage when 'live' then 0 when 'paused' then 1 when 'onboarding' then 2 else 3 end, c.name
$$;
grant execute on function client_health_board(int) to authenticated, service_role;
