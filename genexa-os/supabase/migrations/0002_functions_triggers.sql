-- Genexa OS: helper functions and triggers.

-- ---------------------------------------------------------------------------
-- Who is asking
-- ---------------------------------------------------------------------------
create function app_staff_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from staff where auth_user_id = auth.uid() and status <> 'left' limit 1
$$;

create function app_is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from staff where auth_user_id = auth.uid() and role = 'owner' and status <> 'left'
  )
$$;

-- Server-side callers (service role: sync jobs, webhooks, MCP, seed) carry no user id.
-- anon also has none, but anon has no policies and so never reaches a trigger.
create function app_is_privileged() returns boolean
language sql stable as $$
  select auth.uid() is null or app_is_owner()
$$;

-- ---------------------------------------------------------------------------
-- Time: everything is stored in UTC; days, weeks and months are cut in ET.
-- ---------------------------------------------------------------------------
create function app_today() returns date
language sql stable as $$
  select (now() at time zone 'America/New_York')::date
$$;

create function app_day(ts timestamptz) returns date
language sql stable as $$
  select (ts at time zone 'America/New_York')::date
$$;

-- Monday of the ET week containing d.
create function app_week_start(d date) returns date
language sql immutable as $$
  select (d - (extract(isodow from d)::int - 1))
$$;

-- Business minutes (09:00–17:00 ET, Mon–Fri) between two instants.
create function business_minutes_between(a timestamptz, b timestamptz) returns numeric
language sql stable as $$
  select case when a is null or b is null or b <= a then 0 else coalesce((
    select sum(extract(epoch from (least(b, w.d_end) - greatest(a, w.d_start))) / 60.0)
    from (
      select ((g.d::date + time '09:00') at time zone 'America/New_York') as d_start,
             ((g.d::date + time '17:00') at time zone 'America/New_York') as d_end
      from generate_series(
        (a at time zone 'America/New_York')::date::timestamp,
        (b at time zone 'America/New_York')::date::timestamp,
        interval '1 day') as g(d)
      where extract(isodow from g.d) < 6
    ) w
    where least(b, w.d_end) > greatest(a, w.d_start)
  ), 0) end
$$;

-- The instant n business minutes after ts. A request outside hours starts
-- its clock at the next opening.
create function add_business_minutes(ts timestamptz, n numeric) returns timestamptz
language plpgsql stable as $$
declare
  cur timestamptz := ts;
  remaining numeric := n;
  d date;
  d_open timestamptz;
  d_close timestamptz;
  avail numeric;
begin
  if ts is null or n is null then return null; end if;
  loop
    d := (cur at time zone 'America/New_York')::date;
    d_open := (d + time '09:00') at time zone 'America/New_York';
    d_close := (d + time '17:00') at time zone 'America/New_York';
    if extract(isodow from d) >= 6 or cur >= d_close then
      cur := ((d + 1) + time '09:00') at time zone 'America/New_York';
      continue;
    end if;
    if cur < d_open then cur := d_open; end if;
    avail := extract(epoch from (d_close - cur)) / 60.0;
    if remaining <= avail then
      return cur + (remaining * interval '1 minute');
    end if;
    remaining := remaining - avail;
    cur := ((d + 1) + time '09:00') at time zone 'America/New_York';
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Scoring
-- ---------------------------------------------------------------------------
create function config_value(p_key text) returns numeric
language sql stable security definer set search_path = public as $$
  select value from scoring_config where key = p_key
$$;

create function score_colour(p_key text, p_value numeric) returns text
language sql stable security definer set search_path = public as $$
  select case
    when p_value is null then null
    when c.direction = 'higher_better' then
      case when p_value >= c.green then 'green' when p_value >= c.amber then 'amber' else 'red' end
    when c.direction = 'lower_better' then
      case when p_value <= c.green then 'green' when p_value <= c.amber then 'amber' else 'red' end
  end
  from scoring_config c where c.key = p_key
$$;

create function tech_job_due_at(p_type text, p_requested_at timestamptz) returns timestamptz
language sql stable as $$
  select case p_type
    when 'launch' then p_requested_at + (config_value('sla_launch_hours') * interval '1 hour')
    when 'fix' then add_business_minutes(p_requested_at, config_value('sla_fix_business_minutes'))
  end
$$;

-- ---------------------------------------------------------------------------
-- Generic triggers
-- ---------------------------------------------------------------------------
create function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create function forbid_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'Hard deletes are not allowed on % (soft delete instead)', tg_table_name
    using errcode = 'P0001';
end $$;

-- One audit_log row per changed field. Actor: app.actor setting (e.g. "claude"),
-- else the logged-in staff member's name, else "system".
create function audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_actor text;
  o jsonb;
  n jsonb;
  k text;
begin
  v_actor := coalesce(
    nullif(current_setting('app.actor', true), ''),
    (select name from staff where auth_user_id = auth.uid() limit 1),
    'system');
  n := to_jsonb(new);
  if tg_op = 'INSERT' then
    insert into audit_log (table_name, row_id, field, old_value, new_value, actor)
    values (tg_table_name, (n->>'id')::uuid, '_created', null, n::text, v_actor);
    return new;
  end if;
  o := to_jsonb(old);
  for k in select jsonb_object_keys(n) loop
    if k in ('updated_at', 'synced_at') then continue; end if;
    if (o -> k) is distinct from (n -> k) then
      insert into audit_log (table_name, row_id, field, old_value, new_value, actor)
      values (tg_table_name, (n->>'id')::uuid, k, o ->> k, n ->> k, v_actor);
    end if;
  end loop;
  return new;
end $$;

do $$
declare
  t text;
  audited text[] := array[
    'staff','staff_pay','clients','client_locations','launches','tech_jobs','sla_pauses',
    'appointments','sales','exceptions','eods','tasks','prospects','ideas','touches',
    'briefs','scoring_config','app_settings','reminder_rules','finance_rules','agency_month'];
begin
  for t in
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
  loop
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()',
      t || '_set_updated_at', t);
    execute format('create trigger %I before delete on %I for each row execute function forbid_delete()',
      t || '_forbid_delete', t);
  end loop;
  foreach t in array audited loop
    execute format('create trigger %I after insert or update on %I for each row execute function audit_row()',
      t || '_audit', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Tasks: the rules in 5.7, enforced in the database
-- ---------------------------------------------------------------------------
create function tasks_rules() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_owner_role text;
  v_threshold numeric;
begin
  select role into v_owner_role from staff where id = new.owner_id;

  if v_owner_role = 'media_buyer' and new.category not in ('ads', 'call_centre') then
    raise exception 'TASK_CATEGORY: media buyer tasks must be ads or call_centre' using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' then
    if v_owner_role = 'owner' and new.source <> 'pushpin' then
      if new.source <> 'ryan' or not app_is_privileged() then
        raise exception 'TASK_OWNER_LIST: only Ryan can add to Ryan''s list' using errcode = 'P0001';
      end if;
    end if;

    -- Automated creates are refused when they look like a task the owner already deleted.
    if new.source in ('pushpin', 'claude', 'call', 'slack', 'system') then
      v_threshold := coalesce(config_value('task_deleted_similarity'), 0.6);
      if exists (
        select 1 from deleted_tasks d
        where d.owner_id = new.owner_id
          and similarity(lower(d.title), lower(new.title)) >= v_threshold
      ) then
        raise exception 'TASK_DELETED_MATCH: matches a task this owner deleted' using errcode = 'P0001';
      end if;
    end if;

    if new.status = 'done' then
      new.done_at := coalesce(new.done_at, now());
      new.task_group := 'done';
    end if;
    return new;
  end if;

  -- UPDATE
  if not app_is_privileged() then
    if (to_jsonb(new) - array['status', 'task_group', 'done_at', 'updated_at'])
       is distinct from
       (to_jsonb(old) - array['status', 'task_group', 'done_at', 'updated_at']) then
      raise exception 'TASK_STATUS_ONLY: you can only change the status of your own tasks' using errcode = 'P0001';
    end if;
  end if;

  if new.status = 'done' and old.status <> 'done' then
    new.done_at := coalesce(new.done_at, now());
    new.task_group := 'done';
  elsif new.status <> 'done' and old.status = 'done' then
    new.done_at := null;
    if new.task_group = 'done' then new.task_group := 'week'; end if;
  end if;

  if new.deleted_at is not null and old.deleted_at is null then
    insert into deleted_tasks (owner_id, title, deleted_at)
    values (new.owner_id, new.title, new.deleted_at);
  end if;
  return new;
end $$;

create trigger tasks_rules before insert or update on tasks
  for each row execute function tasks_rules();

-- ---------------------------------------------------------------------------
-- Tech jobs: due time comes from type + requested_at, never typed in
-- ---------------------------------------------------------------------------
create function tech_jobs_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.requested_by := coalesce(new.requested_by, app_staff_id());
    if new.type in ('launch', 'fix') then
      new.due_at := tech_job_due_at(new.type, new.requested_at);
    end if;
  elsif new.type is distinct from old.type or new.requested_at is distinct from old.requested_at then
    if new.type in ('launch', 'fix') then
      new.due_at := tech_job_due_at(new.type, new.requested_at);
    end if;
  end if;

  if new.status = 'done' and new.done_at is null then
    new.done_at := now();
  elsif new.status <> 'done' and new.done_at is not null then
    new.done_at := null;
  end if;
  if new.status = 'working' and new.started_at is null then
    new.started_at := now();
  end if;
  return new;
end $$;

create trigger tech_jobs_defaults before insert or update on tech_jobs
  for each row execute function tech_jobs_defaults();

-- ---------------------------------------------------------------------------
-- Launches: "Live" is impossible until all six QC boxes are ticked
-- ---------------------------------------------------------------------------
create function launches_stage_guard() returns trigger
language plpgsql as $$
declare
  v_qc boolean := new.qc_lead_access and new.qc_calendar_tested and new.qc_test_lead_deleted
    and new.qc_pixel_firing and new.qc_cortana_connected and new.qc_clinic_sheet;
begin
  if (new.qc_passed_at is not null or new.live_at is not null) and not v_qc then
    raise exception 'LAUNCH_QC: all six QC checks must be ticked before QC passed / Live' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger launches_stage_guard before insert or update on launches
  for each row execute function launches_stage_guard();

-- ---------------------------------------------------------------------------
-- Leads: test-lead filter. Test leads are excluded from every metric and alert.
-- ---------------------------------------------------------------------------
create function leads_test_filter() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_name text := lower(btrim(coalesce(new.name, '')));
  v_email text := lower(btrim(coalesce(new.email, '')));
begin
  if new.is_test then return new; end if;
  if v_name like '%test%' or v_email like '%test%' or v_name like 'zz%'
     or exists (
       select 1 from staff s
       where (v_name <> '' and lower(s.name) = v_name)
          or (v_email <> '' and lower(s.email) = v_email)
     ) then
    new.is_test := true;
  end if;
  return new;
end $$;

create trigger leads_test_filter before insert or update of name, email on leads
  for each row execute function leads_test_filter();

-- ---------------------------------------------------------------------------
-- EODs: one per person per day, editable only on that day in the person's timezone
-- ---------------------------------------------------------------------------
create function eods_rules() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_tz text;
  v_role text;
begin
  select timezone, role into v_tz, v_role from staff where id = new.staff_id;
  if not app_is_privileged() then
    if new.staff_id is distinct from app_staff_id() then
      raise exception 'EOD_OWN: you can only file your own EOD' using errcode = 'P0001';
    end if;
    if new.date <> (now() at time zone v_tz)::date then
      raise exception 'EOD_CLOSED: an EOD can only be filed or edited on its own day' using errcode = 'P0001';
    end if;
    new.submitted_at := now();
  end if;
  new.role := coalesce(nullif(new.role, ''), v_role);
  return new;
end $$;

create trigger eods_rules before insert or update on eods
  for each row execute function eods_rules();

-- ---------------------------------------------------------------------------
-- Sales: a close decision means the patient showed. When the clinic logs anything
-- other than 'open' (closed, not closed, follow-up, refunded) the appointment moves
-- to 'showed', even if attendance was never logged or was logged as something else.
-- ---------------------------------------------------------------------------
create function sales_mark_showed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.close_status <> 'open' then
    update appointments
    set attendance = 'showed',
        attendance_logged_at = coalesce(new.logged_at, now()),
        attendance_logged_by = 'clinic'
    where id = new.appointment_id and attendance <> 'showed';
  end if;
  return new;
end $$;

create trigger sales_mark_showed after insert or update of close_status on sales
  for each row execute function sales_mark_showed();
