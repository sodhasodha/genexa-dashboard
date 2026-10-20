-- The launch board updates itself.
--   * A Whop payment for a Genexa product puts the card at Paid: a new customer
--     already gets a client and a launch (0043); now a client that exists but has
--     no open launch (still onboarding or unlaunched) gets one, and an open launch
--     with no payment date gets the payment's time.
--   * A submitted Onboarding Form moves the card to Assets in (which starts the
--     SLA clock and gives Sameer his 24h build job).
--   * A card that sits in a stage too long pings that stage's owner in Slack,
--     then again every 24 hours while it stays there.

-- 1. Payments -> Paid.
create function launches_from_payments() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0; k integer;
begin
  perform set_config('app.actor', 'whop-sync', true);
  -- An open launch with no payment date takes the first Genexa payment's time.
  update launches l set paid_at = p.first_paid
  from (
    select pay.client_id, min(pay.paid_at) as first_paid
    from payments pay
    where pay.status = 'paid' and pay.amount > 0 and pay.client_id is not null
      and pay.product_title ilike coalesce((select value #>> '{}' from app_settings where key = 'whop_mrr_product_prefix'), '') || '%'
    group by pay.client_id
  ) p
  where l.client_id = p.client_id and l.paid_at is null and l.live_at is null;
  get diagnostics k = row_count; n := n + k;
  -- A client still being onboarded who has paid but has no launch at all gets a card.
  insert into launches (client_id, paid_at, owner_id)
  select c.id, min(pay.paid_at), app_role_holder('tech')
  from clients c
  join payments pay on pay.client_id = c.id and pay.status = 'paid' and pay.amount > 0
    and pay.product_title ilike coalesce((select value #>> '{}' from app_settings where key = 'whop_mrr_product_prefix'), '') || '%'
  where c.deleted_at is null and c.stage in ('onboarding', 'unlaunched')
    and not exists (select 1 from launches l where l.client_id = c.id)
  group by c.id;
  get diagnostics k = row_count; n := n + k;
  return n;
end $$;
revoke execute on function launches_from_payments() from public, anon, authenticated;
grant execute on function launches_from_payments() to service_role;

-- 2. Onboarding Form -> Assets in. Same as 0045, with the move added.
create or replace function ghl_form_intake(p_submission_id text, p_kind text, p_client_id uuid, p_org text, p_contact text, p_at timestamptz, p_email text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_client uuid := p_client_id;
  v_launch uuid;
  v_created boolean := false;
  v_name text := btrim(coalesce(p_org, ''));
begin
  if p_kind not in ('new_client', 'onboarding') then raise exception 'GHL_FORM: unknown kind %', p_kind; end if;
  if exists (select 1 from webhook_events where source = 'ghl_survey' and event_id = p_submission_id) then
    return jsonb_build_object('result', 'already_taken');
  end if;
  if v_client is null and (p_kind = 'onboarding' or v_name = '') then
    return jsonb_build_object('result', 'unmatched');
  end if;
  perform set_config('app.actor', 'ghl-forms', true);
  insert into webhook_events (source, event_id, payload)
  values ('ghl_survey', p_submission_id, jsonb_build_object('kind', p_kind, 'organization', v_name, 'at', p_at, 'client_id', v_client));

  if v_client is null then
    insert into clients (name, contact_name, contact_email, stage)
    values (v_name, nullif(btrim(coalesce(p_contact, '')), ''), nullif(lower(btrim(coalesce(p_email, ''))), ''), 'onboarding') returning id into v_client;
    v_created := true;
  else
    update clients set contact_email = nullif(lower(btrim(coalesce(p_email, ''))), '') where id = v_client and contact_email is null and nullif(btrim(coalesce(p_email, '')), '') is not null;
    update clients set name = v_name
    where id = v_client and p_kind = 'new_client' and v_name <> '' and name = contact_name and stage = 'onboarding'
      and not exists (select 1 from clients o where lower(o.name) = lower(v_name) and o.deleted_at is null);
  end if;

  select l.id into v_launch from launches l where l.client_id = v_client order by (l.live_at is null) desc, l.created_at desc limit 1;
  if v_launch is null then
    if (select stage from clients where id = v_client) = 'onboarding' then
      insert into launches (client_id, owner_id) values (v_client, app_role_holder('tech')) returning id into v_launch;
    end if;
  end if;
  if p_kind = 'onboarding' and v_launch is not null then
    update launches set ob_form_done_at = coalesce(ob_form_done_at, p_at) where id = v_launch;
    -- The form is in: the card moves to Assets in, when it now arrives. The clock starts then.
    update launches set assets_in_at = greatest(p_at, now() - interval '1 hour') where id = v_launch and assets_in_at is null and live_at is null;
  end if;
  return jsonb_build_object('result', case when v_created then 'client_created' else 'matched' end, 'client_id', v_client, 'launch_id', v_launch);
end $$;

-- 3. Stuck cards. How long a card may sit in each stage before its owner is pinged.
insert into scoring_config (key, card, label, direction, green, amber, value, unit) values
  ('launch_stuck_paid_hours',            'launch', 'Paid: chase the assets after',               'constant', null, null, 48, 'hours'),
  ('launch_stuck_assets_in_hours',       'launch', 'Assets in: tech build due within',           'constant', null, null, 24, 'hours'),
  ('launch_stuck_tech_built_hours',      'launch', 'Tech built: QC due within',                  'constant', null, null, 24, 'hours'),
  ('launch_stuck_tech_qc_passed_hours',  'launch', 'Tech QC passed: ads due within',             'constant', null, null, 24, 'hours'),
  ('launch_stuck_awaiting_approval_hours','launch', 'Ads built: Aryan approves within',          'constant', null, null, 24, 'hours'),
  ('launch_stuck_approved_hours',        'launch', 'Approved: ads spending within',              'constant', null, null, 24, 'hours')
on conflict (key) do nothing;

-- Every open card that is past its stage's limit, with who owns that stage.
create view launch_stuck with (security_invoker = true) as
with s as (
  select l.id as launch_id, l.client_id, c.name as clinic,
    case
      when l.approved_at is not null then 'approved'
      when l.ads_built_at is not null then 'awaiting_approval'
      when l.qc_passed_at is not null then 'tech_qc_passed'
      when l.build_done_at is not null then 'tech_built'
      when l.assets_in_at is not null then 'assets_in'
      else 'paid'
    end as stage,
    coalesce(l.approved_at, l.ads_built_at, l.qc_passed_at, l.build_done_at, l.assets_in_at, l.paid_at, l.created_at) as entered_at
  from launches l
  join clients c on c.id = l.client_id and c.deleted_at is null and c.stage <> 'churned'
  where l.live_at is null
    and not exists (select 1 from sla_pauses p where p.launch_id = l.id and p.resumed_at is null)
)
select s.*,
  case s.stage when 'paid' then app_role_holder('owner') when 'awaiting_approval' then app_role_holder('owner')
    when 'assets_in' then app_role_holder('tech') when 'tech_built' then app_role_holder('tech')
    else app_role_holder('media_buyer') end as owner_id,
  config_value('launch_stuck_' || s.stage || '_hours') as limit_hours,
  extract(epoch from now() - s.entered_at) / 3600.0 as hours_in_stage,
  -- 0 at the limit, 1 a day later, ...: one ping per 24 hours past the limit.
  floor((extract(epoch from now() - s.entered_at) / 3600.0 - config_value('launch_stuck_' || s.stage || '_hours')) / 24)::int as ping_number
from s
where extract(epoch from now() - s.entered_at) / 3600.0 >= config_value('launch_stuck_' || s.stage || '_hours');
grant select on launch_stuck to authenticated, service_role;

insert into reminder_rules (key, enabled, audience, channel_or_dm, timing, template, urgent, quiet_hours_respected) values
  ('launch_stuck', true, 'the owner of the stage the card is in', 'dm',
   'when a launch card passes its stage limit, then every 24 hours while it stays (held to the person''s shift)', 'Launch stuck', false, true)
on conflict (key) do nothing;

-- Queued by the reminders job; the notifications key (rule, person, launch, window)
-- makes each 24-hour ping go once.
create function launch_stuck_enqueue(p_now timestamptz default now()) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into notifications (rule_key, staff_id, record_type, record_id, window_key, payload, created_at)
  select 'launch_stuck', s.owner_id, 'launches', s.launch_id, s.stage || ':' || s.ping_number,
    jsonb_build_object('clinic', s.clinic, 'stage', s.stage, 'hours', round(s.hours_in_stage), 'limit', s.limit_hours), p_now
  from launch_stuck s
  where s.owner_id is not null
  on conflict do nothing;
  get diagnostics n = row_count;
  -- A card that moved on: its unsent ping is no longer true.
  update notifications n2 set sent_at = p_now, slack_ts = 'skipped:resolved', channel = 'skipped:resolved'
  where n2.rule_key = 'launch_stuck' and n2.sent_at is null
    and not exists (select 1 from launch_stuck s where s.launch_id = n2.record_id and n2.window_key = s.stage || ':' || s.ping_number);
  return n;
end $$;
revoke execute on function launch_stuck_enqueue(timestamptz) from public, anon, authenticated;
grant execute on function launch_stuck_enqueue(timestamptz) to service_role;

-- Open cards whose onboarding form is already in move to Assets in now (the clock
-- starts today, not on the form's old date, so nobody is overdue on day one).
update launches set assets_in_at = now()
where ob_form_done_at is not null and assets_in_at is null and live_at is null
  and client_id in (select id from clients where deleted_at is null and stage <> 'churned');
