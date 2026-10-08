-- "Our people" in the client workspace = a Genexa address, a staff email, or the
-- email of anyone in the TEAM Slack workspace (freelancers and VAs who are not
-- staff rows or use another address). The team list is refreshed by the
-- router-handled job.
create function router_is_staff_email(p_email text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_email is not null and (
    lower(p_email) like '%@genexascaling.com'
    or exists (select 1 from staff s where lower(s.email) = lower(p_email))
    or exists (select 1 from slack_people t where t.workspace = 'team' and lower(t.email) = lower(p_email)))
$$;

create or replace function router_save_person(p_user text, p_email text, p_real_name text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_staff boolean := router_is_staff_email(v_email);
begin
  insert into slack_people (workspace, slack_user_id, email, real_name, is_staff, checked_at)
  values ('client', p_user, v_email, nullif(btrim(coalesce(p_real_name, '')), ''), v_staff, now())
  on conflict (workspace, slack_user_id) do update
    set email = coalesce(excluded.email, slack_people.email),
        real_name = coalesce(excluded.real_name, slack_people.real_name),
        is_staff = case when excluded.email is null then slack_people.is_staff else excluded.is_staff end,
        checked_at = now();
  return (select is_staff from slack_people where workspace = 'client' and slack_user_id = p_user);
end $$;

-- p_people: [{ "id": "U…", "email": "…", "real_name": "…" }] from the team workspace.
-- Returns how many client-workspace accounts are now recognised as ours.
create function router_sync_team_people(p_people jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into slack_people (workspace, slack_user_id, email, real_name, is_staff, checked_at)
  select 'team', x->>'id', nullif(lower(btrim(x->>'email')), ''), nullif(btrim(x->>'real_name'), ''), true, now()
  from jsonb_array_elements(coalesce(p_people, '[]'::jsonb)) x
  where coalesce(x->>'id', '') <> ''
  on conflict (workspace, slack_user_id) do update
    set email = coalesce(excluded.email, slack_people.email), real_name = coalesce(excluded.real_name, slack_people.real_name),
        is_staff = true, checked_at = now();
  update slack_people p set is_staff = true
  where p.workspace = 'client' and not p.is_staff and router_is_staff_email(p.email);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function router_is_staff_email(text), router_sync_team_people(jsonb) from public, anon, authenticated;
grant execute on function router_is_staff_email(text), router_sync_team_people(jsonb) to service_role;
