-- Call centre is moving to Hot Prospector, which is not set up yet. Nothing
-- reads call attempts, first-call time or who called until it is connected.

-- Calls will arrive from one dialler source; rows carry which one.
alter table lead_calls add column source text not null default 'hot_prospector';
alter table lead_calls rename column ghl_message_id to external_id;

-- Hot Prospector as a source that has never synced: anything depending on it stays off.
insert into integration_sync_status (source, schedule_minutes) values ('hot_prospector', 15)
on conflict (source) do nothing;

-- Every rule that needs call data exists but is switched off and tied to that source.
-- When Hot Prospector connects: write its sync, enable these rows, add their detections.
insert into exception_rules (type, label, sources, enabled, urgent) values
  ('lead_not_called',  'Lead not called within 5 min (waiting for Hot Prospector)', '{hot_prospector}', false, true),
  ('lead_stuck_24h',   'No call attempt in 24h (waiting for Hot Prospector)',       '{hot_prospector}', false, false)
on conflict (type) do update set enabled = false, sources = excluded.sources, label = excluded.label;

-- ---------------------------------------------------------------------------
-- Prospect contact details: owner only. They used to sit on the prospect row,
-- which every staff login can read through the API.
-- ---------------------------------------------------------------------------
create table prospect_contacts (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null unique references prospects(id),
  contact text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger prospect_contacts_set_updated_at before update on prospect_contacts for each row execute function set_updated_at();
create trigger prospect_contacts_forbid_delete before delete on prospect_contacts for each row execute function forbid_delete();
create trigger prospect_contacts_audit after insert or update on prospect_contacts for each row execute function audit_row();
alter table prospect_contacts enable row level security;
create policy owner_all on prospect_contacts for all to authenticated using (app_is_owner()) with check (app_is_owner());

insert into prospect_contacts (prospect_id, contact)
select id, contact from prospects where contact is not null and btrim(contact) <> '';

alter table prospects drop column contact;
