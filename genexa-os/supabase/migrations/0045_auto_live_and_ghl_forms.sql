-- 1. A launch goes Live on its own the first day the clinic's ads spend
--    (Cortana). This overrides the six QC boxes: live_source says which way a
--    launch went live, and only 'ad_spend' may skip QC.
alter table launches add column live_source text check (live_source in ('qc', 'ad_spend'));

create or replace function launches_stage_guard() returns trigger
language plpgsql as $$
declare
  v_qc boolean := new.qc_lead_access and new.qc_calendar_tested and new.qc_test_lead_deleted
    and new.qc_pixel_firing and new.qc_cortana_connected and new.qc_clinic_sheet;
begin
  if new.live_at is not null and new.live_source = 'ad_spend' and new.qc_passed_at is null then
    return new;
  end if;
  if (new.qc_passed_at is not null or new.live_at is not null) and not v_qc then
    raise exception 'LAUNCH_QC: all six QC checks must be ticked before QC passed / Live' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- Clinics whose ad numbers are trusted (connected to Cortana, campaign scope
-- verified) and that are not live yet: live from the first day with spend.
create function launches_auto_live()
returns table (client_id uuid, name text, live_date date)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  c record;
  v_launch uuid;
begin
  perform set_config('app.actor', 'cortana-sync', true);
  for c in
    select t.client_id, t.name, min(m.date) as first_spend
    from clients_ads_trusted t
    join ad_metrics_daily m on m.client_id = t.client_id and m.spend > 0
    where t.stage = 'onboarding'
       or exists (select 1 from launches l where l.client_id = t.client_id and l.live_at is null)
    group by t.client_id, t.name
  loop
    select l.id into v_launch from launches l where l.client_id = c.client_id and l.live_at is null order by l.created_at desc limit 1;
    if v_launch is null then
      -- Live already recorded on an earlier launch: nothing to do.
      if exists (select 1 from launches l where l.client_id = c.client_id) then continue; end if;
      insert into launches (client_id, owner_id) values (c.client_id, app_role_holder('tech')) returning id into v_launch;
    end if;
    update launches set live_at = (c.first_spend + time '12:00') at time zone 'America/New_York', live_source = 'ad_spend' where id = v_launch;
    client_id := c.client_id; name := c.name; live_date := c.first_spend;
    return next;
  end loop;
end $$;
revoke execute on function launches_auto_live() from public, anon, authenticated;
grant execute on function launches_auto_live() to service_role;

-- 2. Genexa's own GHL sub-account: the "New Client Form" and "Onboarding Form"
--    surveys. Each submission is taken once. No email, phone or answers are
--    stored: the clinic name, the contact's name and the time only.
-- The contact's email is kept on the client for one purpose: so a later Whop
-- payment from the same person attaches to this client instead of making a second one.
alter table clients add column contact_email text;

create function ghl_form_intake(p_submission_id text, p_kind text, p_client_id uuid, p_org text, p_contact text, p_at timestamptz, p_email text default null)
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
  -- An Onboarding Form we cannot place is left for the next run (the client may not exist yet).
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
    -- A client the Whop sync made is named after the person who paid: the form gives the clinic's name.
    update clients set name = v_name
    where id = v_client and p_kind = 'new_client' and v_name <> '' and name = contact_name and stage = 'onboarding'
      and not exists (select 1 from clients o where lower(o.name) = lower(v_name) and o.deleted_at is null);
    update clients set contact_name = nullif(btrim(coalesce(p_contact, '')), '') where id = v_client and contact_name is null and nullif(btrim(coalesce(p_contact, '')), '') is not null;
  end if;

  select l.id into v_launch from launches l where l.client_id = v_client order by (l.live_at is null) desc, l.created_at desc limit 1;
  if v_launch is null then
    -- Only a clinic still being onboarded gets a launch made for it.
    if (select stage from clients where id = v_client) = 'onboarding' then
      insert into launches (client_id, owner_id) values (v_client, app_role_holder('tech')) returning id into v_launch;
    end if;
  end if;
  if p_kind = 'onboarding' and v_launch is not null then
    update launches set ob_form_done_at = p_at where id = v_launch and ob_form_done_at is null;
  end if;
  return jsonb_build_object('result', case when v_created then 'client_created' else 'matched' end, 'client_id', v_client, 'launch_id', v_launch);
end $$;
revoke execute on function ghl_form_intake(text, text, uuid, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function ghl_form_intake(text, text, uuid, text, text, timestamptz, text) to service_role;

-- 3. The other way round: a clinic that filled the New Client Form first and pays
--    on Whop afterwards is attached to its existing client (same email), not created again.
create function whop_attach_known_contacts() returns integer
language plpgsql security definer set search_path = public as $$
declare u record; n integer := 0;
begin
  perform set_config('app.actor', 'whop-sync', true);
  for u in
    select p.whop_user_id, min(c.id::text)::uuid as client_id
    from payments p join clients c on c.deleted_at is null and c.contact_email is not null and lower(p.customer_email) = c.contact_email
    where p.client_id is null and p.whop_user_id is not null
    group by p.whop_user_id having count(distinct c.id) = 1
  loop
    update clients set whop_customer_ids = array(select distinct x from unnest(coalesce(whop_customer_ids, '{}') || u.whop_user_id) x) where id = u.client_id;
    update payments set client_id = u.client_id where whop_user_id = u.whop_user_id and client_id is null;
    update whop_memberships set client_id = u.client_id where whop_user_id = u.whop_user_id and client_id is null;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function whop_attach_known_contacts() from public, anon, authenticated;
grant execute on function whop_attach_known_contacts() to service_role;
