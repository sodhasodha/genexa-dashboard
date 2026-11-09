-- Hot Leads (/hot-leads), 9 Nov 2026: what CSRs work when the confirmation queue is empty.
--
-- Every 2 minutes the hot-leads sync reads each live clinic's GHL sub-account (read only):
-- conversations, the latest text in from each patient, every calendar's appointments and
-- contact tags. It works out who is hot (lib/hotLeads/rules.ts) and keeps the list here.
-- A lead that stops being hot (booked, tagged DNC, gone quiet) gets dropped_at; nothing is deleted.
-- Message text is never stored: only when the latest text came in and whether it matched a keyword.

-- What the sync remembers per contact between runs, so it only re-reads what changed.
create table hot_lead_contacts (
  client_id uuid not null references clients(id),
  ghl_contact_id text not null,
  name text,
  tags text[] not null default '{}',
  contact_read_at timestamptz,
  -- the conversation's latest message time when its messages were last read
  messages_read_for timestamptz,
  last_inbound_sms_at timestamptz,
  inbound_reschedule boolean not null default false,
  inbound_callback boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (client_id, ghl_contact_id)
);
create trigger hot_lead_contacts_set_updated_at before update on hot_lead_contacts for each row execute function set_updated_at();
create trigger hot_lead_contacts_forbid_delete before delete on hot_lead_contacts for each row execute function forbid_delete();
alter table hot_lead_contacts enable row level security;
create policy owner_all on hot_lead_contacts for all to authenticated using (app_is_owner()) with check (app_is_owner());

create table hot_leads (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  ghl_contact_id text not null,
  patient_name text,
  reason text not null check (reason in ('reschedule', 'callback', 'mid_conversation', 'cancelled', 'no_show')),
  -- when the thing that made them hot happened; newest first within each tier
  signal_at timestamptz not null,
  -- their latest text in, when within 48h (a reply in the last 2h sorts them up)
  last_reply_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  dropped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, ghl_contact_id)
);
create index hot_leads_active_idx on hot_leads (client_id) where dropped_at is null;
create trigger hot_leads_set_updated_at before update on hot_leads for each row execute function set_updated_at();
create trigger hot_leads_forbid_delete before delete on hot_leads for each row execute function forbid_delete();
alter table hot_leads enable row level security;
create policy owner_all on hot_leads for all to authenticated using (app_is_owner()) with check (app_is_owner());
create policy csr_read on hot_leads for select to authenticated using (app_csr_id() is not null);

-- Each time someone opens a lead in GHL: the lead is greyed out for everyone for 15 minutes.
create table hot_lead_opens (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references hot_leads(id),
  staff_id uuid not null references staff(id),
  opened_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index hot_lead_opens_lead_idx on hot_lead_opens (lead_id, opened_at desc);
create trigger hot_lead_opens_forbid_delete before delete on hot_lead_opens for each row execute function forbid_delete();
alter table hot_lead_opens enable row level security;
create policy owner_all on hot_lead_opens for all to authenticated using (app_is_owner()) with check (app_is_owner());
create policy csr_read on hot_lead_opens for select to authenticated using (app_csr_id() is not null);

grant select on hot_lead_contacts, hot_leads, hot_lead_opens to authenticated, service_role;
grant insert, update on hot_lead_contacts, hot_leads, hot_lead_opens to service_role;
revoke all on hot_lead_contacts, hot_leads, hot_lead_opens from anon;

-- Opening a lead is the only write a CSR makes here, and only through this function.
create function hot_lead_open(p_lead uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := coalesce(app_csr_id(), case when app_is_owner() then app_staff_id() end);
begin
  if v_staff is null then raise exception 'HOT_REFUSED: only CSRs and the owner can open hot leads' using errcode = 'P0001'; end if;
  if not exists (select 1 from hot_leads where id = p_lead) then raise exception 'HOT_NOT_FOUND: no such lead' using errcode = 'P0001'; end if;
  insert into hot_lead_opens (lead_id, staff_id) values (p_lead, v_staff);
end $$;
revoke execute on function hot_lead_open(uuid) from public, anon;
grant execute on function hot_lead_open(uuid) to authenticated, service_role;

-- The list: leads still hot, with the clinic and who last opened each one.
-- Runs as its owner (CSRs cannot read clients or other staff) and lets only the owner and CSRs in.
create view hot_lead_list as
select l.id, l.client_id, c.name as clinic, c.ghl_location_id, l.ghl_contact_id, l.patient_name, l.reason,
  l.signal_at, l.last_reply_at, l.last_seen_at, o.opened_at, o.opened_by
from hot_leads l
join clients c on c.id = l.client_id and c.deleted_at is null and c.stage <> 'churned'
left join lateral (
  select x.opened_at, s.name as opened_by from hot_lead_opens x join staff s on s.id = x.staff_id
  where x.lead_id = l.id order by x.opened_at desc limit 1
) o on true
where l.dropped_at is null
  and (app_is_owner() or app_csr_id() is not null or current_user in ('service_role', 'postgres'));
grant select on hot_lead_list to authenticated, service_role;
