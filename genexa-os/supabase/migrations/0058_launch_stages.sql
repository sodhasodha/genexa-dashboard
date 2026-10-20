-- Launch stages, as Ryan set them on 20 Oct 2026:
--   Paid            payment lands in Whop and the card is created (Ryan)
--   Assets in       onboarding form, doctor availability, logo, Google Business profile,
--                   reviews and Meta ad account access are in; the SLA clock starts (Ryan)
--   Tech built      GHL sub-account, SignalHouse, calendars, custom values, AI dialer,
--                   Slack, Cortana and scripts set up (Sameer, 24h)
--   Tech QC passed  one test lead through every step: the six QC boxes (Sameer)
--   Ads built       campaign, creatives and lead form ready (media buyer, 24h);
--                   the card then waits for Aryan's approval, and Aryan gets a DM
--   Live            approved and ads spending; the clinic's term starts (media buyer)
-- The old onboarding-call, OB-form and access timestamps are kept as history.

alter table launches add column assets_in_at timestamptz;
alter table launches add column ads_built_at timestamptz;
alter table launches add column approved_at timestamptz;
alter table launches add column approved_by text;
-- The work each stage hands out, so finishing it moves the card on.
alter table tech_jobs add column launch_id uuid references launches(id);
alter table tasks add column launch_id uuid references launches(id);

-- The SLA clock starts when the assets are in.
create or replace view launch_sla with (security_invoker = true) as
with l as (
  select la.*,
    la.assets_in_at as clock_start,
    coalesce(la.live_at, now()) as end_at
  from launches la
),
m as (
  select
    l.id as launch_id, l.client_id, l.clock_start, l.end_at, l.live_at, l.paid_at,
    config_value('sla_launch_hours') * 60 as sla_minutes,
    extract(epoch from (l.end_at - l.clock_start)) / 60.0 as elapsed_minutes,
    coalesce((
      select sum(greatest(extract(epoch from (
        least(coalesce(sp.resumed_at, l.end_at), l.end_at) - greatest(sp.paused_at, l.clock_start))) / 60.0, 0))
      from sla_pauses sp where sp.launch_id = l.id
    ), 0) as paused_minutes,
    exists (select 1 from sla_pauses sp where sp.launch_id = l.id and sp.resumed_at is null) as is_paused
  from l
)
select
  launch_id,
  client_id,
  clock_start,
  sla_minutes,
  elapsed_minutes,
  paused_minutes,
  greatest(elapsed_minutes - paused_minutes, 0) as genexa_minutes,
  is_paused,
  case when clock_start is null then null
    else greatest(elapsed_minutes - paused_minutes, 0) > sla_minutes end as is_overdue,
  case when live_at is null or clock_start is null then null
    else greatest(elapsed_minutes - paused_minutes, 0) <= sla_minutes end as met_sla,
  case when live_at is null and paid_at is not null
    then app_today() - app_day(paid_at) end as days_waiting_since_paid
from m;

create or replace view launch_board with (security_invoker = true) as
with stages(stage, stage_order) as (
  values ('paid', 1), ('assets_in', 2), ('tech_built', 3), ('tech_qc_passed', 4), ('ads_built', 5), ('live', 6)
),
l as (
  select la.*,
    case
      when la.live_at is not null then 'live'
      when la.ads_built_at is not null then 'ads_built'
      when la.qc_passed_at is not null then 'tech_qc_passed'
      when la.build_done_at is not null then 'tech_built'
      when la.assets_in_at is not null then 'assets_in'
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
  p.paused_at,
  l.assets_in_at, l.ads_built_at, l.approved_at, l.approved_by,
  (l.ads_built_at is not null and l.approved_at is null and l.live_at is null) as awaiting_approval
from l
join clients c on c.id = l.client_id and c.deleted_at is null
join stages st on st.stage = l.stage
left join launch_sla s on s.launch_id = l.id
left join staff o on o.id = l.owner_id
left join sla_pauses p on p.launch_id = l.id and p.resumed_at is null
where l.live_at is null
   or l.live_at > now() - config_value('launch_board_live_days') * interval '1 day';

-- Order and gates. Checked only when a stage is newly reached on an existing
-- launch, so launches from before these stages (and imports) keep what they have.
create or replace function launches_stage_guard() returns trigger
language plpgsql as $$
declare
  v_qc boolean := new.qc_lead_access and new.qc_calendar_tested and new.qc_test_lead_deleted
    and new.qc_pixel_firing and new.qc_cortana_connected and new.qc_clinic_sheet;
  newly_set boolean;
begin
  if new.qc_passed_at is not null and (tg_op = 'INSERT' or old.qc_passed_at is null) and not v_qc then
    raise exception 'LAUNCH_QC: all six QC checks must be ticked before Tech QC passed' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.build_done_at is not null and old.build_done_at is null and new.assets_in_at is null then
    raise exception 'LAUNCH_ORDER: the assets must be in before the tech build is done' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.ads_built_at is not null and old.ads_built_at is null and new.qc_passed_at is null then
    raise exception 'LAUNCH_ORDER: tech QC must pass before the ads are built' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.approved_at is not null and old.approved_at is null and new.ads_built_at is null then
    raise exception 'LAUNCH_ORDER: the ads must be built before they are approved' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.approved_at is not null and old.approved_at is null and not app_is_privileged() then
    raise exception 'LAUNCH_APPROVAL: only Aryan can approve a launch' using errcode = 'P0001';
  end if;
  newly_set := tg_op = 'UPDATE' and new.live_at is not null and old.live_at is null;
  if newly_set and new.approved_at is null then
    raise exception 'LAUNCH_APPROVAL: Aryan must approve the launch before it goes live' using errcode = 'P0001';
  end if;
  return new;
end $$;

create or replace function launches_no_step_back() returns trigger
language plpgsql as $$
begin
  if not app_is_privileged() and (
       (old.paid_at is not null and new.paid_at is null)
    or (old.assets_in_at is not null and new.assets_in_at is null)
    or (old.build_done_at is not null and new.build_done_at is null)
    or (old.qc_passed_at is not null and new.qc_passed_at is null)
    or (old.ads_built_at is not null and new.ads_built_at is null)
    or (old.approved_at is not null and new.approved_at is null)
    or (old.live_at is not null and new.live_at is null)) then
    raise exception 'LAUNCH_BACK: only the owner can move a launch back a stage' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- What each stage hands out. Security definer: the person moving the card may not
-- be allowed to create the other person's work directly.
create function launches_hand_out_work() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_clinic text := (select name from clients where id = new.client_id);
  v_tech uuid := app_role_holder('tech');
  v_buyer uuid := app_role_holder('media_buyer');
  v_owner uuid := app_role_holder('owner');
begin
  -- Assets in: Sameer builds, 24 hours.
  if new.assets_in_at is not null and old.assets_in_at is null
     and not exists (select 1 from tech_jobs j where j.launch_id = new.id and j.deleted_at is null) then
    insert into tech_jobs (client_id, launch_id, type, title, notes, requested_by, requested_at, owner_id, due_override)
    values (new.client_id, new.id, 'launch', 'Build ' || v_clinic,
      'GHL sub-account, SignalHouse, calendars, custom values, AI dialer, Slack, Cortana and scripts. Mark Done when built: the launch moves to Tech built.',
      v_owner, new.assets_in_at, v_tech, new.assets_in_at + interval '24 hours');
  end if;
  -- Tech QC passed: the media buyer builds the ads, 24 hours.
  if new.qc_passed_at is not null and old.qc_passed_at is null and v_buyer is not null
     and not exists (select 1 from tasks t where t.launch_id = new.id and t.deleted_at is null) then
    insert into tasks (owner_id, launch_id, client_id, title, notes, category, source, due_at)
    values (v_buyer, new.id, new.client_id, 'Build ads for ' || v_clinic,
      'Campaign, creatives and lead form. Mark Done when ready: the launch moves to Ads built and waits for Aryan''s approval.',
      'ads', 'system', new.qc_passed_at + interval '24 hours');
  end if;
  -- Ads built: Aryan approves. One DM, once.
  if new.ads_built_at is not null and old.ads_built_at is null and v_owner is not null then
    insert into notifications (rule_key, staff_id, record_type, record_id, payload)
    values ('launch_approval', v_owner, 'launches', new.id, jsonb_build_object('clinic', v_clinic, 'client_id', new.client_id))
    on conflict do nothing;
  end if;
  return new;
end $$;
create trigger launches_hand_out_work after update on launches
  for each row execute function launches_hand_out_work();

-- Finishing the handed-out work moves the card: the build job done = Tech built,
-- the ads task done = Ads built.
create function launch_work_done() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.launch_id is null or new.status <> 'done' or old.status = 'done' then return new; end if;
  if tg_table_name = 'tech_jobs' then
    update launches set build_done_at = coalesce(build_done_at, now()) where id = new.launch_id and assets_in_at is not null;
  else
    update launches set ads_built_at = coalesce(ads_built_at, now()) where id = new.launch_id and qc_passed_at is not null;
  end if;
  return new;
end $$;
create trigger tech_jobs_launch_work_done after update of status on tech_jobs for each row execute function launch_work_done();
create trigger tasks_launch_work_done after update of status on tasks for each row execute function launch_work_done();

insert into reminder_rules (key, enabled, audience, channel_or_dm, timing, template, urgent, quiet_hours_respected) values
  ('launch_approval', true, 'owner', 'dm', 'when the ads for a launch are built', 'Launch waiting for your approval', true, false)
on conflict (key) do nothing;

-- Going live on its own (first day of ad spend) now also needs Aryan's approval.
create or replace function launches_auto_live()
returns table (client_id uuid, name text, live_date date)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  c record;
begin
  perform set_config('app.actor', 'cortana-sync', true);
  for c in
    select l.id as launch_id, t.client_id, t.name,
      (select min(m.date) from ad_metrics_daily m where m.client_id = t.client_id and m.spend > 0 and m.date >= app_day(l.approved_at)) as first_spend
    from launches l
    join clients_ads_trusted t on t.client_id = l.client_id
    where l.live_at is null and l.approved_at is not null
  loop
    if c.first_spend is null then continue; end if;
    update launches set live_at = greatest((c.first_spend + time '12:00') at time zone 'America/New_York', approved_at), live_source = 'ad_spend'
    where id = c.launch_id;
    client_id := c.client_id; name := c.name; live_date := c.first_spend;
    return next;
  end loop;
end $$;

-- Tech and the media buyer each move the card through their own stages.
create policy staff_update_launch_team on launches for update to authenticated
  using (exists (select 1 from staff s where s.id = app_staff_id() and s.role in ('tech', 'media_buyer')))
  with check (exists (select 1 from staff s where s.id = app_staff_id() and s.role in ('tech', 'media_buyer')));
