-- Genexa OS: row level security.
-- Owner: read/write everything.
-- Staff: read everything except pay, finance and the audit log; write only
-- their own EODs, their own tasks' status, and records they own.
-- Sync jobs, webhooks and the MCP endpoint use the service role (bypasses RLS).

create function app_staff_pod() returns text
language sql stable security definer set search_path = public as $$
  select pod from staff where auth_user_id = auth.uid() and status <> 'left' limit 1
$$;

revoke all on all tables in schema public from anon;
grant select, insert, update on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;

do $$
declare
  t text;
  owner_only text[] := array[
    'staff_pay','finance_transactions','finance_rules','agency_month','audit_log','webhook_events','job_runs'];
begin
  for t in
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy owner_all on %I for all to authenticated using (app_is_owner()) with check (app_is_owner())', t);
    if not (t = any (owner_only)) then
      execute format(
        'create policy staff_read on %I for select to authenticated using (app_staff_id() is not null)', t);
    end if;
  end loop;
end $$;

-- Own EODs (the day window is enforced by the eods_rules trigger).
create policy staff_insert_own on eods for insert to authenticated
  with check (staff_id = app_staff_id());
create policy staff_update_own on eods for update to authenticated
  using (staff_id = app_staff_id()) with check (staff_id = app_staff_id());

-- Tasks: any staff member can create one (tasks_rules decides whose list accepts it);
-- owners of a task can change its status only (tasks_rules).
create policy staff_insert on tasks for insert to authenticated
  with check (app_staff_id() is not null);
create policy staff_update_own on tasks for update to authenticated
  using (owner_id = app_staff_id()) with check (owner_id = app_staff_id());

-- Tech work: everyone can request it; the job's owner works it.
create policy staff_request on tech_jobs for insert to authenticated
  with check (requested_by = app_staff_id());
create policy staff_update_own on tech_jobs for update to authenticated
  using (owner_id = app_staff_id()) with check (owner_id = app_staff_id());

create policy staff_pause_own on sla_pauses for insert to authenticated
  with check (
    paused_by = app_staff_id() and (
      exists (select 1 from tech_jobs j where j.id = tech_job_id and j.owner_id = app_staff_id())
      or exists (select 1 from launches l where l.id = launch_id and l.owner_id = app_staff_id())));
create policy staff_resume_own on sla_pauses for update to authenticated
  using (
    exists (select 1 from tech_jobs j where j.id = tech_job_id and j.owner_id = app_staff_id())
    or exists (select 1 from launches l where l.id = launch_id and l.owner_id = app_staff_id()));

create policy staff_update_own on launches for update to authenticated
  using (owner_id = app_staff_id()) with check (owner_id = app_staff_id());

-- Exceptions owned by the person, or by their pod.
create policy staff_update_own on exceptions for update to authenticated
  using (owner_id = app_staff_id() or (owner_pod is not null and owner_pod = app_staff_pod()))
  with check (owner_id = app_staff_id() or (owner_pod is not null and owner_pod = app_staff_pod()));

create policy staff_log_touch on touches for insert to authenticated
  with check (by_id = app_staff_id());

create policy staff_ack_own on notifications for update to authenticated
  using (staff_id = app_staff_id()) with check (staff_id = app_staff_id());
