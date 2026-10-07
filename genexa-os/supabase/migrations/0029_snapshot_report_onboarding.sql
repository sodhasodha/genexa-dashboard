-- Onboarding webhook intake, the daily snapshot, and the weekly client report.
-- Depends on nothing above 0024.

-- ---------------------------------------------------------------------------
-- Onboarding form. One call does everything or nothing:
--   records the event (a repeat of the same event_id creates nothing),
--   creates the client in stage "onboarding" and its launch (owner = tech).
-- A clinic that already exists by name (case-insensitive, not deleted) is never
-- created twice and is not changed; it gets a launch only if it has no open one.
-- Security definer: the caller is the webhook, which has no user.
-- ---------------------------------------------------------------------------
create function onboarding_intake(
  p_event_id text,
  p_clinic_name text,
  p_contact_name text default null,
  p_contact_email text default null,
  p_billing_cycle text default null,
  p_cycle_fee numeric default null,
  p_paid_at timestamptz default null,
  p_ob_form_done_at timestamptz default null,
  p_kickoff_url text default null,
  p_drive_url text default null,
  p_pod text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text := btrim(coalesce(p_clinic_name, ''));
  v_event uuid;
  v_client uuid;
  v_launch uuid;
  v_client_created boolean := false;
  v_launch_created boolean := false;
begin
  if btrim(coalesce(p_event_id, '')) = '' then
    raise exception 'ONBOARDING: event_id is required' using errcode = 'P0001';
  end if;
  if v_name = '' then
    raise exception 'ONBOARDING: clinic_name is required' using errcode = 'P0001';
  end if;

  perform set_config('app.actor', 'onboarding-form', true);

  insert into webhook_events (source, event_id, payload)
  values ('onboarding', p_event_id, jsonb_strip_nulls(jsonb_build_object(
    'event_id', p_event_id, 'clinic_name', v_name, 'contact_name', p_contact_name, 'contact_email', p_contact_email,
    'billing_cycle', p_billing_cycle, 'cycle_fee', p_cycle_fee, 'paid_at', p_paid_at,
    'ob_form_done_at', p_ob_form_done_at, 'kickoff_url', p_kickoff_url, 'drive_url', p_drive_url, 'pod', p_pod)))
  on conflict (source, event_id) do nothing
  returning id into v_event;
  if v_event is null then
    return jsonb_build_object('duplicate', true);
  end if;

  select c.id into v_client from clients c
  where lower(c.name) = lower(v_name) and c.deleted_at is null;

  if v_client is null then
    insert into clients (name, contact_name, stage, billing_cycle, cycle_fee, kickoff_url, drive_url, pod)
    values (v_name, nullif(btrim(p_contact_name), ''), 'onboarding', p_billing_cycle, p_cycle_fee, p_kickoff_url, p_drive_url, p_pod)
    returning id into v_client;
    v_client_created := true;
  end if;

  -- Open = not live yet.
  select l.id into v_launch from launches l
  where l.client_id = v_client and l.live_at is null
  order by l.created_at desc limit 1;

  if v_launch is null then
    insert into launches (client_id, paid_at, ob_form_done_at, owner_id)
    values (v_client, p_paid_at, coalesce(p_ob_form_done_at, now()), app_role_holder('tech'))
    returning id into v_launch;
    v_launch_created := true;
  end if;

  return jsonb_build_object(
    'duplicate', false,
    'client_id', v_client,
    'client_created', v_client_created,
    'launch_id', v_launch,
    'launch_created', v_launch_created,
    'message', case
      when v_client_created then 'Created the client and its launch'
      when v_launch_created then 'Client already exists: no second client created, a new launch was attached'
      else 'Client already exists and has an open launch: nothing created'
    end);
end $$;

revoke execute on function onboarding_intake(text, text, text, text, text, numeric, timestamptz, timestamptz, text, text, text)
  from public, anon, authenticated;
grant execute on function onboarding_intake(text, text, text, text, text, numeric, timestamptz, timestamptz, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Daily snapshot, part 1: store the scorecards of the ET week containing p_day
-- (default: yesterday), so a finished week keeps the numbers it ended on.
-- ---------------------------------------------------------------------------
create function snapshot_person_scores(p_day date default null) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_week date := app_week_start(coalesce(p_day, app_today() - 1));
  v_rows integer;
begin
  insert into person_scores_snapshot (staff_id, week_start, card, metric, value, numerator, denominator, colour, is_baseline)
  select distinct on (w.staff_id, w.week_start, w.card, w.metric)
    w.staff_id, w.week_start, w.card, w.metric, w.value, w.numerator, w.denominator, w.colour, coalesce(w.is_baseline, false)
  from person_scores_weekly w
  where w.week_start = v_week and w.staff_id is not null
  order by w.staff_id, w.week_start, w.card, w.metric
  on conflict (staff_id, week_start, card, metric) do update
    set value = excluded.value, numerator = excluded.numerator, denominator = excluded.denominator,
        colour = excluded.colour, is_baseline = excluded.is_baseline;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('week_start', v_week, 'rows', v_rows);
end $$;

-- ---------------------------------------------------------------------------
-- Daily snapshot, part 2: freeze a finished month into agency_month.
-- snapshot holds:
--   overview            the month's overview_period row
--   mrr_whop_recurring  whop_mrr_at(last day of the month); null if Whop has never synced
--   mrr                 sum of client_fees.monthly_fee AT THE TIME OF FREEZING (as_of), not at month end
--   clients_by_stage    count of clients per stage, also at the time of freezing
--   clients             that month's client_monthly rows, with the clinic name
-- A frozen month is never overwritten, and a month that has not ended is not frozen.
-- ---------------------------------------------------------------------------
create function freeze_agency_month(p_month date) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month' - interval '1 day')::date;
  v_snapshot jsonb;
  v_id uuid;
begin
  if p_month is null then
    raise exception 'AGENCY_MONTH: a month is required' using errcode = 'P0001';
  end if;
  if v_end >= app_today() then
    return jsonb_build_object('frozen', false, 'month', v_month, 'reason', 'month_not_over');
  end if;
  if exists (select 1 from agency_month a where a.month = v_month and a.frozen_at is not null) then
    return jsonb_build_object('frozen', false, 'month', v_month, 'reason', 'already_frozen');
  end if;

  v_snapshot := jsonb_build_object(
    'month', v_month,
    'month_end', v_end,
    'as_of', now(),
    'overview', (select to_jsonb(o) from overview_period(v_month, v_end) o),
    'mrr_whop_recurring', case
      when exists (select 1 from integration_sync_status s where s.source = 'whop' and s.last_success_at is not null)
      then whop_mrr_at(v_end) end,
    'mrr', (select sum(f.monthly_fee) from client_fees f),
    'clients_by_stage', (
      select coalesce(jsonb_object_agg(s.stage, s.n), '{}'::jsonb)
      from (select c.stage, count(*) as n from clients c where c.deleted_at is null group by c.stage) s),
    'clients', (
      select coalesce(jsonb_agg(to_jsonb(m) || jsonb_build_object('name', c.name) order by c.name), '[]'::jsonb)
      from client_monthly m join clients c on c.id = m.client_id
      where m.month = v_month));

  insert into agency_month (month, snapshot, frozen_at) values (v_month, v_snapshot, now())
  on conflict (month) do update set snapshot = excluded.snapshot, frozen_at = excluded.frozen_at
    where agency_month.frozen_at is null
  returning id into v_id;
  if v_id is null then
    return jsonb_build_object('frozen', false, 'month', v_month, 'reason', 'already_frozen');
  end if;
  return jsonb_build_object('frozen', true, 'month', v_month, 'id', v_id);
end $$;

-- ---------------------------------------------------------------------------
-- Weekly client report: one row per live clinic with a verified Cortana
-- business, for the Mon-Sun week containing p_week_start and the week before.
--   spend   ad_metrics_daily summed over the week (null when there are no rows)
--   funnel  client_funnel_period, so each patient counts once per week
-- Funnel counts are 0 when Cortana has synced and found nothing, and null when
-- Cortana has never synced. Revenue is 0 only when there were no closes.
-- ---------------------------------------------------------------------------
create function client_week_report(p_week_start date)
returns table (
  client_id uuid, client_name text, week_start date, week_end date,
  spend numeric, leads numeric, booked numeric, confirmed numeric, shows numeric, no_shows numeric,
  closes numeric, revenue numeric, cost_per_booked numeric, show_rate numeric,
  prev_spend numeric, prev_leads numeric, prev_booked numeric, prev_confirmed numeric, prev_shows numeric,
  prev_no_shows numeric, prev_closes numeric, prev_revenue numeric, prev_cost_per_booked numeric, prev_show_rate numeric)
language sql stable as $$
  with w as (
    select app_week_start(p_week_start) as ws
  ),
  known as (
    select exists (
      select 1 from integration_sync_status s where s.source = 'cortana' and s.last_success_at is not null) as funnel
  ),
  live as (
    select c.id, c.name from clients c
    where c.deleted_at is null and c.stage = 'live' and c.cortana_business_id is not null
      and c.id not in (select u.client_id from clients_ads_unverified u)
  ),
  n as (
    select
      l.id as client_id, k.which,
      (select sum(d.spend) from ad_metrics_daily d
        where d.client_id = l.id and d.date between k.d_from and k.d_to) as spend,
      case when known.funnel then coalesce(f.leads, 0)::numeric end as leads,
      case when known.funnel then coalesce(f.booked, 0)::numeric end as booked,
      case when known.funnel then coalesce(f.confirmed, 0)::numeric end as confirmed,
      case when known.funnel then coalesce(f.shows, 0)::numeric end as shows,
      case when known.funnel then coalesce(f.no_shows, 0)::numeric end as no_shows,
      case when known.funnel then coalesce(f.closes, 0)::numeric end as closes,
      case when known.funnel then case when coalesce(f.closes, 0) = 0 then 0 else f.revenue end end as revenue
    from live l
    cross join w
    cross join known
    cross join lateral (values ('cur', w.ws, w.ws + 6), ('prev', w.ws - 7, w.ws - 1)) as k(which, d_from, d_to)
    left join lateral (
      select p.* from client_funnel_period(k.d_from, k.d_to) p where p.client_id = l.id
    ) f on true
  )
  select
    l.id, l.name, w.ws, w.ws + 6,
    c.spend, c.leads, c.booked, c.confirmed, c.shows, c.no_shows, c.closes, c.revenue,
    c.spend / nullif(c.booked, 0), c.shows / nullif(c.shows + c.no_shows, 0),
    p.spend, p.leads, p.booked, p.confirmed, p.shows, p.no_shows, p.closes, p.revenue,
    p.spend / nullif(p.booked, 0), p.shows / nullif(p.shows + p.no_shows, 0)
  from live l
  cross join w
  join n c on c.client_id = l.id and c.which = 'cur'
  join n p on p.client_id = l.id and p.which = 'prev'
  order by l.name
$$;

-- The stored report: one per clinic per week. Nothing here sends it.
create table client_reports (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  week_start date not null,
  body_markdown text not null,
  numbers jsonb not null default '{}',
  emailed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, week_start)
);
create index client_reports_week_idx on client_reports (week_start);

do $$
declare t text;
begin
  foreach t in array array['client_reports'] loop
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', t || '_set_updated_at', t);
    execute format('create trigger %I before delete on %I for each row execute function forbid_delete()', t || '_forbid_delete', t);
    execute format('create trigger %I after insert or update on %I for each row execute function audit_row()', t || '_audit', t);
    execute format('alter table %I enable row level security', t);
    execute format('create policy owner_all on %I for all to authenticated using (app_is_owner()) with check (app_is_owner())', t);
    execute format('create policy staff_read on %I for select to authenticated using (app_staff_id() is not null)', t);
  end loop;
end $$;

-- Write (or rewrite) a week's report. One that has already been emailed is left as sent.
create function store_client_report(p_client_id uuid, p_week_start date, p_body text, p_numbers jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_id uuid;
begin
  perform set_config('app.actor', 'weekly-client-report', true);
  insert into client_reports (client_id, week_start, body_markdown, numbers)
  values (p_client_id, app_week_start(p_week_start), p_body, coalesce(p_numbers, '{}'::jsonb))
  on conflict (client_id, week_start) do update
    set body_markdown = excluded.body_markdown, numbers = excluded.numbers
    where client_reports.emailed_at is null
  returning id into v_id;
  return jsonb_build_object('stored', v_id is not null, 'id', v_id);
end $$;

-- What the owner's Monday message needs: who the owner is, and the red clinics with reasons.
create function weekly_report_digest() returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'owner_id', o.id,
    'slack_user_id', o.slack_user_id,
    'owner_email', o.email,
    'red', (
      select coalesce(jsonb_agg(jsonb_build_object('name', h.name, 'reasons', h.reasons) order by h.name), '[]'::jsonb)
      from client_health h where h.colour = 'red'))
  from (select app_role_holder('owner') as owner_id) x
  left join staff o on o.id = x.owner_id
$$;

-- Claim the week's message before sending it. Returns the notification id, or
-- null when the week already has one (sent, or being sent). A send that failed
-- is marked "failed:..." and can be claimed again.
create function weekly_report_claim(p_week_start date, p_staff_id uuid) returns uuid
language plpgsql set search_path = public as $$
declare
  v_id uuid;
  v_window text := app_week_start(p_week_start)::text;
begin
  insert into notifications (rule_key, staff_id, window_key)
  values ('weekly_client_report', p_staff_id, v_window)
  on conflict do nothing
  returning id into v_id;
  if v_id is null then
    update notifications set channel = null
    where rule_key = 'weekly_client_report' and staff_id = p_staff_id and record_id is null
      and window_key = v_window and sent_at is null and channel like 'failed:%'
    returning id into v_id;
  end if;
  return v_id;
end $$;

create function weekly_report_sent(p_id uuid, p_ok boolean, p_slack_ts text default null, p_channel text default null, p_error text default null)
returns void
language sql set search_path = public as $$
  update notifications
  set sent_at = case when p_ok then now() end,
      slack_ts = case when p_ok then p_slack_ts end,
      channel = case when p_ok then p_channel else 'failed:' || left(coalesce(p_error, 'unknown'), 80) end
  where id = p_id and rule_key = 'weekly_client_report' and sent_at is null
$$;

-- Jobs only: these write, or read owner-only numbers.
revoke execute on function snapshot_person_scores(date) from public, anon, authenticated;
revoke execute on function freeze_agency_month(date) from public, anon, authenticated;
revoke execute on function store_client_report(uuid, date, text, jsonb) from public, anon, authenticated;
revoke execute on function weekly_report_digest() from public, anon, authenticated;
revoke execute on function weekly_report_claim(date, uuid) from public, anon, authenticated;
revoke execute on function weekly_report_sent(uuid, boolean, text, text, text) from public, anon, authenticated;
grant execute on function snapshot_person_scores(date) to service_role;
grant execute on function freeze_agency_month(date) to service_role;
grant execute on function store_client_report(uuid, date, text, jsonb) to service_role;
grant execute on function weekly_report_digest() to service_role;
grant execute on function weekly_report_claim(date, uuid) to service_role;
grant execute on function weekly_report_sent(uuid, boolean, text, text, text) to service_role;
