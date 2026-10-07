-- Genexa OS: Clients and Launches pages.
-- Depends on nothing above 0014.

insert into scoring_config (key, card, label, direction, green, amber, value, unit) values
  ('launch_board_live_days', 'launches', 'Days a live launch stays on the board', 'constant', null, null, 14, 'days')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Launch board: one row per launch on the kanban.
-- Stage = the furthest step whose timestamp is set. A launch with no timestamp
-- at all sits in "paid" with paid_at null (the card says so).
-- Live launches drop off after launch_board_live_days.
-- ---------------------------------------------------------------------------
create view launch_board with (security_invoker = true) as
with stages(stage, stage_order) as (
  values ('paid', 1), ('ob_call_booked', 2), ('ob_call_done', 3), ('ob_form_complete', 4),
         ('access_granted', 5), ('built', 6), ('qc_passed', 7), ('live', 8)
),
l as (
  select la.*,
    case
      when la.live_at is not null then 'live'
      when la.qc_passed_at is not null then 'qc_passed'
      when la.build_done_at is not null then 'built'
      when la.access_done_at is not null then 'access_granted'
      when la.ob_form_done_at is not null then 'ob_form_complete'
      when la.ob_call_done_at is not null then 'ob_call_done'
      when la.ob_call_booked_at is not null then 'ob_call_booked'
      else 'paid'
    end as stage
  from launches la
)
select
  l.id as launch_id,
  l.client_id,
  c.name as client_name,
  l.owner_id,
  o.name as owner_name,
  l.stage,
  st.stage_order,
  (select n.stage from stages n where n.stage_order = st.stage_order + 1) as next_stage,
  (select p.stage from stages p where p.stage_order = st.stage_order - 1) as prev_stage,
  l.paid_at, l.ob_call_booked_at, l.ob_call_done_at, l.ob_form_done_at, l.access_done_at,
  l.build_done_at, l.qc_passed_at, l.live_at,
  l.qc_lead_access, l.qc_calendar_tested, l.qc_test_lead_deleted,
  l.qc_pixel_firing, l.qc_cortana_connected, l.qc_clinic_sheet,
  (l.qc_lead_access::int + l.qc_calendar_tested::int + l.qc_test_lead_deleted::int
    + l.qc_pixel_firing::int + l.qc_cortana_connected::int + l.qc_clinic_sheet::int) as qc_done,
  (l.qc_lead_access and l.qc_calendar_tested and l.qc_test_lead_deleted
    and l.qc_pixel_firing and l.qc_cortana_connected and l.qc_clinic_sheet) as qc_all,
  l.broke_week1,
  -- Not live yet: days since payment, coloured by the same thresholds as client health.
  s.days_waiting_since_paid as days_waiting,
  score_colour('health_paid_not_launched_days', s.days_waiting_since_paid::numeric) as waiting_colour,
  -- Live: how long payment to live took.
  case when l.live_at is not null and l.paid_at is not null
    then app_day(l.live_at) - app_day(l.paid_at) end as days_paid_to_live,
  (s.clock_start is not null) as clock_started,
  -- Null until the clock starts (OB form and access both done).
  case when s.clock_start is not null then round((s.genexa_minutes / 60.0)::numeric, 1) end as sla_hours_elapsed,
  round((s.sla_minutes / 60.0)::numeric, 1) as sla_hours_allowed,
  case when s.clock_start is not null then round((s.paused_minutes / 60.0)::numeric, 1) end as sla_hours_paused,
  s.is_paused,
  s.is_overdue,
  s.met_sla,
  p.id as pause_id,
  p.reason as pause_reason,
  p.evidence_note as pause_note,
  p.paused_at
from l
join clients c on c.id = l.client_id and c.deleted_at is null
join stages st on st.stage = l.stage
left join launch_sla s on s.launch_id = l.id
left join staff o on o.id = l.owner_id
left join sla_pauses p on p.launch_id = l.id and p.resumed_at is null
where l.live_at is null
   or l.live_at > now() - config_value('launch_board_live_days') * interval '1 day';

-- ---------------------------------------------------------------------------
-- Going live: the clinic becomes live and gets its launch date (never overwritten).
-- Security definer because the launch owner cannot update clients.
-- ---------------------------------------------------------------------------
create function launches_go_live() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_went_live boolean := false;
begin
  if tg_op = 'INSERT' then
    v_went_live := new.live_at is not null;
  else
    v_went_live := new.live_at is not null and old.live_at is null;
  end if;
  if v_went_live then
    update clients
    set stage = 'live',
        launch_date = coalesce(launch_date, app_day(new.live_at))
    where id = new.client_id and deleted_at is null
      and (stage <> 'live' or launch_date is null);
  end if;
  return new;
end $$;

create trigger launches_go_live after insert or update of live_at on launches
  for each row execute function launches_go_live();

-- Moving a launch back (clearing a stage timestamp) is the app owner's call only.
create function launches_no_step_back() returns trigger
language plpgsql as $$
begin
  if not app_is_privileged() and (
       (old.paid_at is not null and new.paid_at is null)
    or (old.ob_call_booked_at is not null and new.ob_call_booked_at is null)
    or (old.ob_call_done_at is not null and new.ob_call_done_at is null)
    or (old.ob_form_done_at is not null and new.ob_form_done_at is null)
    or (old.access_done_at is not null and new.access_done_at is null)
    or (old.build_done_at is not null and new.build_done_at is null)
    or (old.qc_passed_at is not null and new.qc_passed_at is null)
    or (old.live_at is not null and new.live_at is null)) then
    raise exception 'LAUNCH_BACK: only the owner can move a launch back a stage' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger launches_no_step_back before update on launches
  for each row execute function launches_no_step_back();

-- ---------------------------------------------------------------------------
-- Logging a touch moves the clinic's "last contact (us)" forward.
-- Security definer because staff can log touches but cannot update clients.
-- ---------------------------------------------------------------------------
create function touches_set_last_contact() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.deleted_at is null then
    update clients set last_contact_us = new.at
    where id = new.client_id and (last_contact_us is null or last_contact_us < new.at);
  end if;
  return new;
end $$;

create trigger touches_set_last_contact after insert on touches
  for each row execute function touches_set_last_contact();

-- ---------------------------------------------------------------------------
-- Lanes: one row per client per lane, with a colour and the reason for it.
-- Failing rules come from client_health_reasons. With nothing failing a lane is
-- green for a live clinic and grey for one that is not live. A lane is also grey
-- when there is nothing to judge it on: no Cortana business, an unverified
-- campaign scope, a stale Cortana sync, or no client reply ever recorded.
-- ---------------------------------------------------------------------------
create view client_lanes with (security_invoker = true) as
with lanes(lane, lane_order, rules) as (
  values
    ('launch',      1, array['paid_not_launched']),
    ('ads',         2, array['zero_spend', 'cost_per_booked']),
    ('call_centre', 3, array[]::text[]),
    ('outcomes',    4, array['outcomes_overdue', 'guarantee']),
    ('contact',     5, array['no_reply'])
),
failing as (
  select h.client_id, ln.lane,
    case when bool_or(h.severity = 'red') then 'red' else 'amber' end as colour,
    string_agg(h.reason, ' · ' order by case h.severity when 'red' then 0 else 1 end, h.rule) as reason
  from client_health_reasons h
  join lanes ln on h.rule = any (ln.rules)
  group by h.client_id, ln.lane
),
cortana as (
  select exists (select 1 from source_freshness f where f.source = 'cortana' and f.is_stale) as stale
),
base as (
  select c.id as client_id, c.name, c.stage, c.pod, c.last_reply_client, ln.lane, ln.lane_order,
    f.colour as failing_colour, f.reason as failing_reason,
    case
      when ln.lane not in ('ads', 'outcomes') then null
      when c.cortana_business_id is null then 'Not connected to Cortana'
      when c.id in (select client_id from clients_ads_unverified) then 'Ad numbers unverified'
      when cortana.stale then 'Cortana sync is stale'
    end as no_source
  from clients c
  cross join lanes ln
  cross join cortana
  left join failing f on f.client_id = c.id and f.lane = ln.lane
  where c.deleted_at is null
)
select
  client_id, name, stage, pod, lane, lane_order,
  case
    when lane = 'call_centre' then 'grey'
    when failing_colour is not null then failing_colour
    when stage <> 'live' then 'grey'
    when no_source is not null then 'grey'
    when lane = 'contact' and last_reply_client is null then 'grey'
    else 'green'
  end as colour,
  case
    when lane = 'call_centre' then 'Needs GHL'
    when failing_colour is not null then failing_reason
    when stage <> 'live' then 'Not live (' || stage || ')'
    when no_source is not null then no_source
    when lane = 'contact' and last_reply_client is null then 'No client reply on record'
    else 'No issues found'
  end as reason
from base;

-- ---------------------------------------------------------------------------
-- Clients list for one month: facts, health, renewal and that month's numbers.
-- A function (not a view) so the month is a parameter; it runs as the caller,
-- so RLS applies. ads_state says why the month's numbers are missing.
-- ---------------------------------------------------------------------------
create function client_list(p_month date)
returns table (
  client_id uuid, name text, stage text, pod text, churned boolean,
  health_colour text, health_rank integer, health_reasons text,
  days_live integer, monthly_fee numeric,
  renewal_date date, renewal_status text, renewal_amount numeric,
  guarantee_text text, guarantee_target_amount numeric, guarantee_deadline date,
  ads_state text,
  spend numeric, leads numeric, booked numeric, confirmed numeric, shows numeric, closes numeric, revenue numeric,
  cpl numeric, cost_per_booked numeric, booking_rate numeric, confirmation_rate numeric,
  show_rate numeric, close_rate numeric, ctr numeric, roas numeric,
  last_contact_us timestamptz, last_reply_client timestamptz, next_action text)
language sql stable as $$
  select
    c.id, c.name, c.stage, c.pod, (c.stage = 'churned'),
    h.colour,
    case h.colour when 'red' then 0 when 'amber' then 1 when 'green' then 2 end,
    h.reasons,
    case when c.stage in ('live', 'paused') and c.launch_date is not null then app_today() - c.launch_date end,
    c.monthly_fee,
    r.renewal_date, r.status, r.renewal_amount,
    c.guarantee_text, c.guarantee_target_amount, c.guarantee_deadline,
    case
      when c.cortana_business_id is null then 'not_connected'
      when c.id in (select u.client_id from clients_ads_unverified u) then 'unverified'
      else 'ok'
    end,
    m.spend, m.leads, m.booked, m.confirmed, m.shows, m.closes, m.revenue,
    m.cpl, m.cost_per_booked, m.booking_rate, m.confirmation_rate,
    m.show_rate, m.close_rate, m.ctr, m.roas,
    c.last_contact_us, c.last_reply_client, c.next_action
  from clients c
  left join client_health h on h.client_id = c.id
  left join renewals r on r.client_id = c.id
  left join client_monthly m on m.client_id = c.id and m.month = date_trunc('month', p_month)::date
  where c.deleted_at is null
$$;
