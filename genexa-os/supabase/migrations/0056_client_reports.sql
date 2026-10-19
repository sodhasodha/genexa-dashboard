-- Reports: what each live clinic got for a date range, as sent to the clinic.
-- The same sources as everywhere else: ad spend from Cortana's account days
-- (unverified clinics left out), the funnel from Cortana's events, counted once
-- per patient. Each row carries a send status with its reasons:
--   Don't send  the numbers are not complete or not trustworthy for this range
--   Check       the numbers are real but something would read badly or is missing
--   Good        fine to send as is
-- Red line for ROAS: under this, a clinic's results are terrible and are shown in red
-- on Clients and Reports. No revenue at all on real spend counts as 0x.
insert into scoring_config (key, card, label, direction, green, amber, value, unit) values
  ('roas_red_below', 'ads', 'ROAS below this is shown in red', 'constant', null, null, 3, 'x')
on conflict (key) do nothing;

create function client_report(p_from date, p_to date)
returns table (
  client_id uuid, name text, launch_date date,
  spend numeric, leads numeric, booked numeric, shows numeric, closes numeric, revenue numeric, roas numeric,
  status text, reasons text[], roas_bad boolean)
language sql stable as $$
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
      (select count(*) from cortana_events e where e.client_id = c.id and not e.is_test and e.event = 'purchase'
         and coalesce(e.value, 0) = 0 and app_day(e.occurred_at) between p_from and p_to) as closes_without_amount,
      (select count(*) from appointments a where a.client_id = c.id and a.attendance = 'scheduled'
         and a.scheduled_for < now() - interval '24 hours' and app_day(a.scheduled_for) between p_from and p_to) as unlogged
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
$$;
grant execute on function client_report(date, date) to authenticated, service_role;
