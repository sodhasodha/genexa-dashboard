-- Each clinic's login for the client dashboard (client.genexascaling.com), so the
-- Monday outcome message can carry it. Owner only: no staff login can read this
-- table, and it is not part of any view. Changes are not copied into audit_log,
-- so the password lives in one place only.
create table client_dashboard_logins (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null unique references clients(id),
  username text not null check (btrim(username) <> ''),
  password text not null check (btrim(password) <> ''),
  updated_by uuid references staff(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger client_dashboard_logins_set_updated_at before update on client_dashboard_logins for each row execute function set_updated_at();
create trigger client_dashboard_logins_forbid_delete before delete on client_dashboard_logins for each row execute function forbid_delete();
alter table client_dashboard_logins enable row level security;
create policy owner_all on client_dashboard_logins for all to authenticated using (app_is_owner()) with check (app_is_owner());
revoke all on client_dashboard_logins from anon;
grant select, insert, update on client_dashboard_logins to authenticated, service_role;

update reminder_rules
set template = 'Hi [clinic] 👋 You have [X] patient outcomes waiting to be updated. Please log them here: [link]. Username: [username] · Password: [password]. Thanks!'
where key = 'outcome_nudge';
