-- Client request router.
--
-- Clients write in their own Slack workspace (two channels per clinic: General
-- and Scheduling). Every message they post is stored here, classified by the
-- model, and turned into the right piece of work:
--   tech -> tech_jobs, ads -> a task for the media buyer, ryan -> an exception.
-- All routing decisions are in route_client_request so they are atomic and tested.
-- Nothing here queues anything for the client workspace: the only output there is
-- a thread reply, sent by the app and only while client_workspace_thread_replies is on.

alter table clients add column timezone text default 'America/New_York';
alter table tasks add column source_url text;
alter table tech_jobs add column source_url text;
alter table exceptions add column source_url text;
-- Exceptions had nowhere to keep the client's own words or a repeat of the same ask.
alter table exceptions add column notes text;

-- ---------------------------------------------------------------------------
-- Who is who in Slack. Filled from users.info the first time a user is seen.
-- ---------------------------------------------------------------------------
create table slack_people (
  id uuid primary key default gen_random_uuid(),
  workspace text not null check (workspace in ('team', 'client')),
  slack_user_id text not null,
  -- null when the lookup failed: the sender is then treated as a client.
  email text,
  real_name text,
  is_staff boolean not null default false,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace, slack_user_id)
);

-- ---------------------------------------------------------------------------
-- One row per client message. `owner`, `title`, ... are the model's answer and
-- are never overwritten by a person; a person's choice goes in assigned_owner.
-- ---------------------------------------------------------------------------
create table client_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  channel text not null,
  channel_kind text not null check (channel_kind in ('general', 'scheduling')),
  slack_ts text not null,
  -- Set when the message was itself posted inside a thread.
  thread_ts text,
  slack_user_id text,
  sender_name text,
  text text not null,
  permalink text not null,
  received_at timestamptz not null,
  mode text not null default 'live' check (mode in ('live', 'backfill')),
  attempts integer not null default 0,
  classify_error text,
  -- A worker holds the message while it asks the model, so two workers do not both ask.
  claimed_at timestamptz,
  is_request boolean,
  owner text check (owner in ('tech', 'ads', 'ryan')),
  title text,
  due_at timestamptz,
  urgency text check (urgency in ('normal', 'urgent')),
  confidence numeric check (confidence >= 0 and confidence <= 1),
  tech_type text check (tech_type in ('fix', 'other')),
  classified_at timestamptz,
  status text not null default 'new'
    check (status in ('new', 'not_request', 'routed', 'merged', 'triage', 'pending_approval', 'rejected')),
  triage_reason text,
  assigned_owner text check (assigned_owner in ('tech', 'ads', 'ryan')),
  routed_table text check (routed_table in ('tasks', 'tech_jobs', 'exceptions')),
  routed_id uuid,
  merged_into uuid references client_requests(id),
  -- A Slack ts once sent; 'sending' while in flight; 'off' / 'skipped:<why>' when it never will be.
  reply_logged_ts text,
  reply_done_ts text,
  verdict text check (verdict in ('right', 'wrong')),
  verdict_by uuid references staff(id),
  verdict_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, slack_ts)
);
create index client_requests_status_idx on client_requests (status, received_at);
create index client_requests_client_idx on client_requests (client_id, received_at desc);

do $$
declare t text;
begin
  foreach t in array array['slack_people', 'client_requests'] loop
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', t || '_set_updated_at', t);
    execute format('create trigger %I before delete on %I for each row execute function forbid_delete()', t || '_forbid_delete', t);
    execute format('create trigger %I after insert or update on %I for each row execute function audit_row()', t || '_audit', t);
    execute format('alter table %I enable row level security', t);
    execute format('create policy owner_all on %I for all to authenticated using (app_is_owner()) with check (app_is_owner())', t);
    execute format('create policy staff_read on %I for select to authenticated using (app_staff_id() is not null)', t);
    execute format('revoke all on %I from anon', t);
    execute format('grant select, insert, update on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;

-- A client's own message is logged as a touch, but it is not us contacting them:
-- "last contact (us)" only moves for touches we made.
create or replace function touches_set_last_contact() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.deleted_at is null
     and not (new.by_id is null and coalesce(new.external_ref like 'slack:%', false)) then
    update clients set last_contact_us = new.at
    where id = new.client_id and (last_contact_us is null or last_contact_us < new.at);
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------
create function router_permalink(p_channel text, p_ts text) returns text
language sql immutable as $$
  select 'https://slack.com/archives/' || p_channel || '/p' || replace(p_ts, '.', '')
$$;

create function router_replies_enabled() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select value = 'true'::jsonb from app_settings where key = 'client_workspace_thread_replies'), false)
$$;

-- Is the piece of work a request was turned into still open / now finished?
create function router_item_state(p_table text, p_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select case p_table
    when 'tasks' then (select case when t.deleted_at is not null then 'deleted' when t.status = 'done' then 'closed' else 'open' end from tasks t where t.id = p_id)
    when 'tech_jobs' then (select case when j.deleted_at is not null then 'deleted' when j.status = 'done' then 'closed' else 'open' end from tech_jobs j where j.id = p_id)
    when 'exceptions' then (select case when e.status = 'resolved' then 'closed' else 'open' end from exceptions e where e.id = p_id)
  end
$$;

-- Why the database refused to create the work, in plain English.
create function router_refusal_reason(p_error text) returns text
language sql immutable as $$
  select case
    when p_error like 'TASK_DELETED_MATCH%' then 'Looks like a task the media buyer already deleted, so it was not created again'
    when p_error like 'TASK_CATEGORY%' then 'Outside the media buyer''s remit (their tasks must be ads or call centre)'
    when p_error like 'TASK_OWNER_LIST%' then 'Only Ryan can add to Ryan''s task list'
    else 'Could not be created: ' || regexp_replace(p_error, '^[A-Z_]+: ', '')
  end
$$;

-- ---------------------------------------------------------------------------
-- Listening
-- ---------------------------------------------------------------------------
-- Which clinic a channel belongs to and what is known about the sender.
-- Null when the channel is not a client's General or Scheduling channel.
create function router_sender(p_channel text, p_user text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'client_id', c.id,
    'channel_kind', case when c.slack_general_id = p_channel then 'general' else 'scheduling' end,
    'person', (
      select jsonb_build_object('is_staff', p.is_staff, 'email', p.email, 'real_name', p.real_name, 'checked_at', p.checked_at)
      from slack_people p where p.workspace = 'client' and p.slack_user_id = p_user))
  from clients c
  where c.deleted_at is null and p_channel in (c.slack_general_id, c.slack_scheduling_id)
  order by c.created_at
  limit 1
$$;

-- Remember a client-workspace user. Staff = the email is a staff member's, or a
-- Genexa address. No email (the lookup failed) = not staff.
create function router_save_person(p_user text, p_email text, p_real_name text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_staff boolean;
begin
  v_staff := v_email is not null and (
    v_email like '%@genexascaling.com'
    or exists (select 1 from staff s where lower(s.email) = v_email));
  insert into slack_people (workspace, slack_user_id, email, real_name, is_staff, checked_at)
  values ('client', p_user, v_email, nullif(btrim(coalesce(p_real_name, '')), ''), v_staff, now())
  on conflict (workspace, slack_user_id) do update
    set email = coalesce(excluded.email, slack_people.email),
        real_name = coalesce(excluded.real_name, slack_people.real_name),
        is_staff = case when excluded.email is null then slack_people.is_staff else excluded.is_staff end,
        checked_at = now();
  return (select is_staff from slack_people where workspace = 'client' and slack_user_id = p_user);
end $$;

-- Store one client message. Safe to call twice for the same message (Slack retries):
-- the second call changes nothing and says created = false.
-- A live message also moves the clinic's "last reply" and logs a touch.
-- A backfilled message changes nothing on the clinic.
create function router_store_message(
  p_channel text, p_ts text, p_user text, p_sender_name text, p_text text,
  p_thread_ts text default null, p_mode text default 'live'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_client uuid;
  v_kind text;
  v_at timestamptz;
  v_link text;
  v_id uuid;
begin
  select c.id, case when c.slack_general_id = p_channel then 'general' else 'scheduling' end
  into v_client, v_kind
  from clients c
  where c.deleted_at is null and p_channel in (c.slack_general_id, c.slack_scheduling_id)
  order by c.created_at limit 1;
  if v_client is null then return null; end if;
  if p_ts is null or p_ts !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception 'ROUTER_BAD_TS: not a Slack timestamp' using errcode = 'P0001';
  end if;
  if p_mode not in ('live', 'backfill') then
    raise exception 'ROUTER_BAD_MODE: mode must be live or backfill' using errcode = 'P0001';
  end if;

  perform set_config('app.actor', 'request-router', true);
  v_at := to_timestamp(p_ts::double precision);
  v_link := router_permalink(p_channel, p_ts);

  insert into client_requests (client_id, channel, channel_kind, slack_ts, thread_ts, slack_user_id, sender_name, text, permalink, received_at, mode)
  values (v_client, p_channel, v_kind, p_ts, nullif(p_thread_ts, p_ts), p_user, nullif(btrim(coalesce(p_sender_name, '')), ''), coalesce(p_text, ''), v_link, v_at, p_mode)
  on conflict (channel, slack_ts) do nothing
  returning id into v_id;

  if v_id is null then
    return (select jsonb_build_object('id', r.id, 'created', false, 'status', r.status)
            from client_requests r where r.channel = p_channel and r.slack_ts = p_ts);
  end if;

  if p_mode = 'live' then
    update clients set last_reply_client = v_at
    where id = v_client and (last_reply_client is null or last_reply_client < v_at);
    insert into touches (client_id, at, kind, by_id, note, external_ref)
    values (v_client, v_at, 'slack', null, 'Client message in #' || v_kind || ' ' || v_link, 'slack:' || p_channel || ':' || p_ts)
    on conflict do nothing;
  end if;
  return jsonb_build_object('id', v_id, 'created', true, 'status', 'new');
end $$;

-- ---------------------------------------------------------------------------
-- Classifying
-- ---------------------------------------------------------------------------
-- Messages still waiting for the model, oldest first.
create function router_pending(p_limit integer default 20, p_now timestamptz default now()) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(x.id), '{}') from (
    select r.id from client_requests r
    where r.status = 'new' and (r.claimed_at is null or r.claimed_at < p_now - interval '3 minutes')
    order by r.received_at
    limit p_limit
  ) x
$$;

-- Take a message to classify. Null when it is already classified or another worker has it.
create function router_claim(p_id uuid, p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r client_requests;
begin
  update client_requests set claimed_at = p_now
  where id = p_id and status = 'new' and (claimed_at is null or claimed_at < p_now - interval '3 minutes')
  returning * into r;
  if not found then return null; end if;
  return (
    select jsonb_build_object(
      'id', r.id, 'text', r.text, 'channel_kind', r.channel_kind, 'received_at', r.received_at, 'mode', r.mode,
      'client_name', c.name, 'timezone', coalesce(c.timezone, 'America/New_York'))
    from clients c where c.id = r.client_id);
end $$;

-- The model failed or answered with something unusable. The message stays
-- unclassified for the next run; after 5 attempts a person decides.
create function router_classify_failed(p_id uuid, p_error text) returns text
language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  perform set_config('app.actor', 'request-router', true);
  update client_requests
  set attempts = attempts + 1,
      classify_error = left(coalesce(p_error, 'unknown error'), 500),
      claimed_at = null,
      status = case when attempts + 1 >= 5 then 'triage' else status end,
      triage_reason = case when attempts + 1 >= 5 then 'could not be classified' else triage_reason end
  where id = p_id and status = 'new'
  returning status into v_status;
  return v_status;
end $$;

create function router_result(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', r.id, 'status', r.status, 'mode', r.mode, 'owner', coalesce(r.assigned_owner, r.owner),
    'routed_table', r.routed_table, 'routed_id', r.routed_id, 'merged_into', r.merged_into,
    'triage_reason', r.triage_reason,
    'urgent_dm', r.status = 'routed' and r.routed_table = 'exceptions' and r.urgency = 'urgent')
  from client_requests r where r.id = p_id
$$;

-- ---------------------------------------------------------------------------
-- Routing. Two ways in:
--   * the model's answer for a new message (p_force_owner null);
--   * a person's decision on a Triage or backfill item (p_force_owner set):
--     the stored classification is kept and the work is created for that owner.
-- ---------------------------------------------------------------------------
create function route_client_request(
  p_id uuid,
  p_is_request boolean default null,
  p_owner text default null,
  p_title text default null,
  p_due_at timestamptz default null,
  p_urgency text default null,
  p_confidence numeric default null,
  p_tech_type text default null,
  p_force_owner text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r client_requests;
  twin client_requests;
  v_client_name text;
  v_tz text;
  v_owner text;
  v_role text;
  v_staff uuid;
  v_title text;
  v_notes text;
  v_urgent boolean;
  v_type text;
  v_table text;
  v_item uuid;
  v_line text;
  v_reason text;
begin
  perform set_config('app.actor', 'request-router', true);
  select * into r from client_requests where id = p_id for update;
  if not found then
    raise exception 'ROUTER_NOT_FOUND: no such client request' using errcode = 'P0001';
  end if;

  if p_force_owner is null then
    -- Already decided (a second worker, or a Slack retry): change nothing.
    if r.status <> 'new' then return router_result(p_id); end if;
    if p_is_request is null then
      raise exception 'ROUTER_NO_ANSWER: a classification is required' using errcode = 'P0001';
    end if;

    update client_requests
    set is_request = p_is_request,
        owner = case when p_is_request then p_owner end,
        title = nullif(btrim(coalesce(p_title, '')), ''),
        due_at = case when p_is_request then p_due_at end,
        urgency = coalesce(p_urgency, 'normal'),
        confidence = p_confidence,
        tech_type = case when p_is_request and p_owner = 'tech' then coalesce(p_tech_type, 'other') end,
        classified_at = now(), classify_error = null, claimed_at = null
    where id = p_id
    returning * into r;

    if r.confidence is null or r.confidence < 0.8 then
      update client_requests set status = 'triage',
        triage_reason = 'Low confidence (' || coalesce(round(r.confidence * 100)::text || '%', 'none given') || ')'
      where id = p_id;
      return router_result(p_id);
    elsif not r.is_request then
      update client_requests set status = 'not_request' where id = p_id;
      return router_result(p_id);
    elsif r.owner is null then
      update client_requests set status = 'triage', triage_reason = 'A request with no clear owner' where id = p_id;
      return router_result(p_id);
    elsif r.mode = 'backfill' then
      -- Nothing from a backfill becomes work until a person approves it.
      update client_requests set status = 'pending_approval' where id = p_id;
      return router_result(p_id);
    end if;
    v_owner := r.owner;
  else
    if r.status not in ('triage', 'pending_approval') then
      raise exception 'ROUTER_STATE: only a Triage or awaiting-approval request can be assigned' using errcode = 'P0001';
    end if;
    if p_force_owner not in ('tech', 'ads', 'ryan') then
      raise exception 'ROUTER_OWNER: owner must be tech, ads or ryan' using errcode = 'P0001';
    end if;
    v_owner := p_force_owner;
    update client_requests set assigned_owner = v_owner, triage_reason = null where id = p_id returning * into r;
  end if;

  select c.name, coalesce(c.timezone, 'America/New_York') into v_client_name, v_tz from clients c where c.id = r.client_id;
  v_title := coalesce(r.title, nullif(left(btrim(regexp_replace(r.text, '\s+', ' ', 'g')), 80), ''), 'Client request');
  v_notes := r.text || E'\n' || r.permalink;
  v_urgent := coalesce(r.urgency, 'normal') = 'urgent';
  v_role := case v_owner when 'tech' then 'tech' when 'ads' then 'media_buyer' else 'owner' end;
  v_staff := app_role_holder(v_role);
  if v_staff is null then
    update client_requests set status = 'triage',
      triage_reason = 'No one on the team holds the ' || replace(v_role, '_', ' ') || ' role'
    where id = p_id;
    return router_result(p_id);
  end if;

  -- The same clinic asking for the same thing again within 7 days adds to the
  -- open item instead of making a second one.
  select o.* into twin
  from client_requests o
  where o.client_id = r.client_id and o.id <> r.id and o.status = 'routed'
    and coalesce(o.assigned_owner, o.owner) = v_owner
    and o.received_at > r.received_at - interval '7 days'
    and o.received_at < r.received_at + interval '7 days'
    and similarity(lower(o.title), lower(v_title)) >= 0.5
    and router_item_state(o.routed_table, o.routed_id) = 'open'
  order by similarity(lower(o.title), lower(v_title)) desc, o.received_at desc
  limit 1;

  if found then
    v_line := 'Also asked ' || to_char(r.received_at at time zone v_tz, 'Dy FMDD Mon') || ': ' || r.permalink;
    if twin.routed_table = 'tasks' then
      update tasks set notes = concat_ws(E'\n', notes, v_line) where id = twin.routed_id;
    elsif twin.routed_table = 'tech_jobs' then
      update tech_jobs set notes = concat_ws(E'\n', notes, v_line) where id = twin.routed_id;
    else
      update exceptions set notes = concat_ws(E'\n', notes, v_line) where id = twin.routed_id;
    end if;
    update client_requests
    set status = 'merged', merged_into = twin.id, routed_table = twin.routed_table, routed_id = twin.routed_id, title = v_title
    where id = p_id;
    return router_result(p_id);
  end if;

  begin
    if v_owner = 'tech' then
      v_type := coalesce(r.tech_type, 'other');
      v_table := 'tech_jobs';
      -- A fix gets its due time from the SLA (tech_jobs_defaults); anything else uses the date the client gave.
      insert into tech_jobs (client_id, type, title, notes, requested_at, due_at, owner_id, source_url)
      values (r.client_id, v_type, v_title, v_notes, r.received_at, case when v_type = 'other' then r.due_at end, v_staff, r.permalink)
      returning id into v_item;
    elsif v_owner = 'ads' then
      v_table := 'tasks';
      insert into tasks (owner_id, title, client_id, category, source, priority, due, notes, source_url)
      values (v_staff, v_title, r.client_id, 'ads', 'slack', case when v_urgent then 'high' else 'medium' end,
              (r.due_at at time zone v_tz)::date, v_notes, r.permalink)
      returning id into v_item;
    else
      v_table := 'exceptions';
      insert into exceptions (type, client_id, owner_id, severity, reason, record_table, record_id, dedupe_key, source_url, notes)
      values ('client_request', r.client_id, v_staff, case when v_urgent then 'red' else 'amber' end,
              v_client_name || ': ' || v_title, 'client_requests', r.id, 'client_request:' || r.id, r.permalink, v_notes)
      returning id into v_item;
      -- The owner's DM, queued like any exception DM. Urgent ones carry their own
      -- text and the urgent flag, so they go out at once instead of waiting for a shift.
      insert into notifications (rule_key, staff_id, record_type, record_id, payload)
      values ('exception_opened', v_staff, 'exceptions', v_item,
              case when v_urgent then jsonb_build_object(
                'reason', v_client_name || ': ' || v_title, 'severity', 'red', 'type', 'client_request', '_urgent', true) end)
      on conflict do nothing;
    end if;
  exception when sqlstate 'P0001' then
    v_reason := router_refusal_reason(sqlerrm);
    update client_requests set status = 'triage', triage_reason = v_reason where id = p_id;
    return router_result(p_id);
  end;

  update client_requests
  set status = 'routed', routed_table = v_table, routed_id = v_item, title = v_title,
      -- With replies switched off nothing is left waiting to be sent later.
      reply_logged_ts = case when r.mode = 'backfill' then 'skipped:backfill'
                             when not router_replies_enabled() then 'off' end
  where id = p_id;
  return router_result(p_id);
end $$;

-- The owner's buttons: Triage (Assign / Not a request) and backfill (Approve / Reject).
create function router_decide(p_id uuid, p_action text, p_owner text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r client_requests;
begin
  if auth.uid() is not null and not app_is_owner() then
    raise exception 'ROUTER_OWNER_ONLY: only the owner can decide on client requests' using errcode = 'P0001';
  end if;
  select * into r from client_requests where id = p_id for update;
  if not found then
    raise exception 'ROUTER_NOT_FOUND: no such client request' using errcode = 'P0001';
  end if;

  if p_action = 'assign' then
    return route_client_request(p_id, p_force_owner => p_owner);
  elsif p_action = 'approve' then
    if r.status <> 'pending_approval' or r.owner is null then
      raise exception 'ROUTER_STATE: only a request awaiting approval can be approved' using errcode = 'P0001';
    end if;
    return route_client_request(p_id, p_force_owner => r.owner);
  elsif p_action = 'not_request' then
    if r.status <> 'triage' then
      raise exception 'ROUTER_STATE: only a Triage request can be marked not a request' using errcode = 'P0001';
    end if;
    perform set_config('app.actor', 'request-router', true);
    update client_requests set status = 'not_request', triage_reason = null where id = p_id;
  elsif p_action = 'reject' then
    if r.status <> 'pending_approval' then
      raise exception 'ROUTER_STATE: only a request awaiting approval can be rejected' using errcode = 'P0001';
    end if;
    perform set_config('app.actor', 'request-router', true);
    update client_requests set status = 'rejected' where id = p_id;
  else
    raise exception 'ROUTER_ACTION: unknown action' using errcode = 'P0001';
  end if;
  return router_result(p_id);
end $$;

-- Was the model right? Owner only. Null clears the verdict.
create function router_set_verdict(p_id uuid, p_verdict text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not app_is_owner() then
    raise exception 'ROUTER_OWNER_ONLY: only the owner can judge the router' using errcode = 'P0001';
  end if;
  if p_verdict is not null and p_verdict not in ('right', 'wrong') then
    raise exception 'ROUTER_VERDICT: verdict must be right or wrong' using errcode = 'P0001';
  end if;
  update client_requests
  set verdict = p_verdict,
      verdict_by = case when p_verdict is null then null else app_staff_id() end,
      verdict_at = case when p_verdict is null then null else now() end
  where id = p_id and classified_at is not null;
end $$;

-- ---------------------------------------------------------------------------
-- Thread replies: the only thing ever sent to the client workspace.
-- "Logged" once a live request is routed, "Done" once its work is closed.
-- While the setting is off, anything that would have been sent is closed as
-- 'off', so switching it on later sends nothing old.
-- ---------------------------------------------------------------------------
create function router_replies_due(p_limit integer default 50) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_on boolean := router_replies_enabled();
  v jsonb;
begin
  perform set_config('app.actor', 'request-router', true);
  if not v_on then
    update client_requests set reply_logged_ts = 'off'
    where status = 'routed' and mode = 'live' and reply_logged_ts is null;
    update client_requests r set reply_done_ts = 'off'
    where r.status = 'routed' and r.mode = 'live' and r.reply_logged_ts ~ '^[0-9]' and r.reply_done_ts is null
      and router_item_state(r.routed_table, r.routed_id) = 'closed';
    return jsonb_build_object('enabled', false, 'items', '[]'::jsonb);
  end if;

  -- Work that was removed rather than finished is never announced as done.
  update client_requests r set reply_done_ts = 'skipped:deleted'
  where r.status = 'routed' and r.mode = 'live' and r.reply_logged_ts ~ '^[0-9]' and r.reply_done_ts is null
    and router_item_state(r.routed_table, r.routed_id) = 'deleted';

  select coalesce(jsonb_agg(x.item order by x.received_at), '[]'::jsonb) into v
  from (
    select r.received_at, jsonb_build_object(
      'id', r.id,
      'kind', case when r.reply_logged_ts is null then 'logged' else 'done' end,
      'channel', r.channel,
      'thread_ts', coalesce(r.thread_ts, r.slack_ts),
      'owner_name', split_part(btrim(s.name), ' ', 1),
      'title', r.title,
      'due_at', case when r.routed_table = 'tech_jobs' then j.due_at else r.due_at end,
      'timezone', coalesce(c.timezone, 'America/New_York')) as item
    from client_requests r
    join clients c on c.id = r.client_id
    left join tasks t on r.routed_table = 'tasks' and t.id = r.routed_id
    left join tech_jobs j on r.routed_table = 'tech_jobs' and j.id = r.routed_id
    left join exceptions e on r.routed_table = 'exceptions' and e.id = r.routed_id
    left join staff s on s.id = coalesce(t.owner_id, j.owner_id, e.owner_id)
    where r.status = 'routed' and r.mode = 'live'
      and (r.reply_logged_ts is null
           or (r.reply_logged_ts ~ '^[0-9]' and r.reply_done_ts is null
               and router_item_state(r.routed_table, r.routed_id) = 'closed'))
    order by r.received_at
    limit p_limit
  ) x;
  return jsonb_build_object('enabled', true, 'items', v);
end $$;

-- Take a reply before sending it, so it cannot be sent twice. False = not yours to send.
create function router_reply_claim(p_id uuid, p_kind text) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not router_replies_enabled() then return false; end if;
  perform set_config('app.actor', 'request-router', true);
  if p_kind = 'logged' then
    update client_requests set reply_logged_ts = 'sending'
    where id = p_id and status = 'routed' and mode = 'live' and reply_logged_ts is null
    returning id into v_id;
  elsif p_kind = 'done' then
    update client_requests set reply_done_ts = 'sending'
    where id = p_id and status = 'routed' and mode = 'live' and reply_logged_ts ~ '^[0-9]' and reply_done_ts is null
    returning id into v_id;
  end if;
  return v_id is not null;
end $$;

-- Record the Slack ts of a sent reply. A null ts = the send failed: release it for the next run.
create function router_reply_finish(p_id uuid, p_kind text, p_ts text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.actor', 'request-router', true);
  if p_kind = 'logged' then
    update client_requests set reply_logged_ts = p_ts where id = p_id and reply_logged_ts = 'sending';
  elsif p_kind = 'done' then
    update client_requests set reply_done_ts = p_ts where id = p_id and reply_done_ts = 'sending';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- How often the model is right: last 7 and 30 days, overall and per owner
-- ('none' = messages it gave no owner, mostly "not a request").
-- ---------------------------------------------------------------------------
create view router_accuracy with (security_invoker = true) as
select
  w.days as window_days,
  o.owner,
  count(r.id)::integer as classified,
  (count(r.id) filter (where r.verdict is not null))::integer as judged,
  (count(r.id) filter (where r.verdict = 'right'))::integer as right_count,
  (count(r.id) filter (where r.verdict = 'wrong'))::integer as wrong_count,
  round(100.0 * count(r.id) filter (where r.verdict = 'right') / nullif(count(r.id) filter (where r.verdict is not null), 0), 1) as accuracy_pct
from (values (7), (30)) w(days)
cross join (values ('all'), ('tech'), ('ads'), ('ryan'), ('none')) o(owner)
left join client_requests r
  on r.classified_at is not null
 and r.received_at >= now() - make_interval(days => w.days)
 and (o.owner = 'all' or coalesce(r.owner, 'none') = o.owner)
group by w.days, o.owner;

revoke all on router_accuracy from anon;
grant select on router_accuracy to authenticated, service_role;

do $$
declare f text;
begin
  -- Server-side only (webhook, jobs, backfill script).
  foreach f in array array[
    'router_sender(text, text)', 'router_save_person(text, text, text)',
    'router_store_message(text, text, text, text, text, text, text)',
    'router_pending(integer, timestamptz)', 'router_claim(uuid, timestamptz)', 'router_classify_failed(uuid, text)',
    'router_result(uuid)',
    'route_client_request(uuid, boolean, text, text, timestamptz, text, numeric, text, text)',
    'router_replies_due(integer)', 'router_reply_claim(uuid, text)', 'router_reply_finish(uuid, text, text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  -- The owner's buttons (each checks for the owner itself).
  foreach f in array array['router_decide(uuid, text, text)', 'router_set_verdict(uuid, text)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
