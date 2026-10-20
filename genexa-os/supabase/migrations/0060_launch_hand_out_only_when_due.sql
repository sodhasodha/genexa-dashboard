-- Work is only handed out for a stage that is still to do: a launch that is already
-- past Tech built (or Ads built) when an earlier stage gets its date never makes the job again.
create or replace function launches_hand_out_work() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_clinic text := (select name from clients where id = new.client_id);
  v_tech uuid := app_role_holder('tech');
  v_buyer uuid := app_role_holder('media_buyer');
  v_owner uuid := app_role_holder('owner');
begin
  -- Assets in: Sameer builds, 24 hours.
  if new.assets_in_at is not null and old.assets_in_at is null and new.build_done_at is null
     and not exists (select 1 from tech_jobs j where j.launch_id = new.id and j.deleted_at is null) then
    insert into tech_jobs (client_id, launch_id, type, title, notes, requested_by, requested_at, owner_id, due_override)
    values (new.client_id, new.id, 'launch', 'Build ' || v_clinic,
      'GHL sub-account, SignalHouse, calendars, custom values, AI dialer, Slack, Cortana and scripts. Mark Done when built: the launch moves to Tech built.',
      v_owner, new.assets_in_at, v_tech, new.assets_in_at + interval '24 hours');
  end if;
  -- Tech QC passed: the media buyer builds the ads, 24 hours.
  if new.qc_passed_at is not null and old.qc_passed_at is null and new.ads_built_at is null and v_buyer is not null
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
