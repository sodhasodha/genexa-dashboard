-- The Clients board also shows each clinic's revenue this month so far.
drop function client_health_board(int);
create function client_health_board(p_days int default 7)
returns table (
  client_id uuid, name text, stage text, colour text, bottleneck text, reasons text,
  ads_state text, spend numeric, revenue numeric, roas numeric, cpl numeric, cost_per_booked numeric, cost_per_close numeric,
  leads numeric, booked numeric, closes numeric, window_from date, window_to date, mtd_revenue numeric)
language sql stable as $$
  select
    c.id, c.name, c.stage, h.colour,
    -- Reasons come worst first: the first one is the main bottleneck.
    nullif(split_part(coalesce(h.reasons, ''), ' · ', 1), ''),
    h.reasons,
    case when c.cortana_business_id is null then 'not_connected' when m.unverified then 'unverified' else 'ok' end,
    m.spend, m.revenue, m.revenue / nullif(m.spend, 0), m.cpl, m.cost_per_booked, m.cost_per_close,
    m.leads, m.booked, m.closes, m.window_from, m.window_to,
    -- This calendar month so far (ET), the same clinic revenue the Overview counts.
    case when c.cortana_business_id is null or m.unverified then null else coalesce(f.revenue, 0) end
  from clients c
  left join client_health h on h.client_id = c.id
  left join media_account_metrics(p_days) m on m.client_id = c.id
  left join client_funnel_period(date_trunc('month', app_today())::date, app_today()) f on f.client_id = c.id
  where c.deleted_at is null and c.stage <> 'churned'
  order by case h.colour when 'red' then 0 when 'amber' then 1 when 'green' then 2 else 3 end,
    case c.stage when 'live' then 0 when 'paused' then 1 when 'onboarding' then 2 else 3 end, c.name
$$;
grant execute on function client_health_board(int) to authenticated, service_role;
