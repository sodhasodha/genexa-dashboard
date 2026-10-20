-- Client requests for Sameer or the media buyer go to Aryan first.
--   1. The router no longer creates their task or tech job itself: the request
--      waits as "awaiting approval" and Aryan gets a Slack DM with Approve / Deny.
--   2. Approve creates the task or tech job (with its deadline); the assignee is
--      told in Slack by the existing "new task" / "new tech job" messages.
--   3. A task or tech job of theirs that misses its deadline DMs Aryan once
--      (again if the deadline is moved and missed again).
-- Requests for Aryan himself still open straight away as before.

create or replace function route_client_request(
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
    elsif r.mode = 'backfill' or r.owner in ('tech', 'ads') then
      -- Nothing becomes Sameer's or the media buyer's work until Aryan approves it.
      -- A live request reaches him as a Slack DM with Approve / Deny.
      update client_requests set status = 'pending_approval' where id = p_id;
      if r.mode = 'live' then
        insert into notifications (rule_key, staff_id, record_type, record_id, payload)
        select 'request_approval', app_role_holder('owner'), 'client_requests', p_id,
          jsonb_build_object('clinic', c.name, 'title', coalesce(r.title, 'Client request'), 'owner', r.owner,
            'urgency', r.urgency, 'permalink', r.permalink, 'due_at', r.due_at, 'channel_kind', r.channel_kind)
        from clients c where c.id = r.client_id
        on conflict do nothing;
      end if;
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
      -- A fix gets its due time from the SLA (tech_jobs_defaults); anything else uses the deadline the
      -- client gave, or the end of the tech person's next shift. A deadline the owner set on the
      -- request beats both (due_override).
      insert into tech_jobs (client_id, type, title, notes, requested_at, due_at, due_override, owner_id, source_url)
      values (r.client_id, v_type, v_title, v_notes, r.received_at,
              case when v_type = 'other' then coalesce(r.due_at, staff_next_shift_end(v_staff)) end, r.assigned_due_at, v_staff, r.permalink)
      returning id into v_item;
    elsif v_owner = 'ads' then
      v_table := 'tasks';
      -- The deadline: the owner's choice, else the client's, else the end of the media buyer's next shift.
      insert into tasks (owner_id, title, client_id, category, source, priority, due, due_at, notes, source_url)
      values (v_staff, v_title, r.client_id, 'ads', 'slack', case when v_urgent then 'high' else 'medium' end,
              (coalesce(r.assigned_due_at, r.due_at, staff_next_shift_end(v_staff)) at time zone v_tz)::date,
              coalesce(r.assigned_due_at, r.due_at, staff_next_shift_end(v_staff)), v_notes, r.permalink)
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

create or replace function router_mark_handled(p_channel text, p_ts text, p_thread_ts text default null, p_by text default null) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_thread text := nullif(nullif(btrim(coalesce(p_thread_ts, '')), ''), p_ts);
  v_n integer;
begin
  if p_ts is null or p_ts !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception 'ROUTER_BAD_TS: not a Slack timestamp' using errcode = 'P0001';
  end if;
  perform set_config('app.actor', 'request-router', true);
  update client_requests r
  set status = 'handled', handled_reason = 'Handled in Slack', handled_at = now(),
      handled_by = nullif(btrim(coalesce(p_by, '')), ''), handled_ts = p_ts
  where r.channel = p_channel
    -- Triage: any later staff post in the channel, or a reply in the thread.
    -- Awaiting Aryan's approval: only a staff reply in that message's thread.
    and (r.status = 'triage' or (r.status = 'pending_approval' and r.mode = 'live' and v_thread is not null))
    and case
      when v_thread is not null then
        r.slack_ts = v_thread or (r.thread_ts = v_thread and r.slack_ts::numeric < p_ts::numeric)
      else r.slack_ts::numeric < p_ts::numeric
    end;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Approve / Deny from the Slack DM. Only the owner's Slack account may decide.
create function slack_router_decide(p_slack_user text, p_action text, p_request uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v staff%rowtype;
  r client_requests;
  res jsonb;
begin
  select * into v from staff where slack_user_id = p_slack_user and status <> 'left' order by created_at limit 1;
  if not found then return jsonb_build_object('result', 'unknown_user'); end if;
  if v.role <> 'owner' then return jsonb_build_object('result', 'refused', 'actor', v.name); end if;
  if p_action not in ('approve', 'reject') then return jsonb_build_object('result', 'bad_request'); end if;
  select * into r from client_requests where id = p_request;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  if r.status <> 'pending_approval' then
    return jsonb_build_object('result', 'already', 'status', r.status, 'handled_by', r.handled_by, 'title', r.title, 'actor', v.name);
  end if;
  perform set_config('app.actor', v.name, true);
  res := router_decide(p_request, p_action);
  select * into r from client_requests where id = p_request;
  return jsonb_build_object('result', case when p_action = 'approve' then 'approved' else 'rejected' end, 'actor', v.name, 'title', r.title,
    'routed_table', r.routed_table,
    'assignee', (select s.name from staff s where s.id = coalesce(
        (select t.owner_id from tasks t where r.routed_table = 'tasks' and t.id = r.routed_id),
        (select j.owner_id from tech_jobs j where r.routed_table = 'tech_jobs' and j.id = r.routed_id))),
    'due_at', coalesce(
        (select t.due_at from tasks t where r.routed_table = 'tasks' and t.id = r.routed_id),
        (select j.due_at from tech_jobs j where r.routed_table = 'tech_jobs' and j.id = r.routed_id)));
end $$;
revoke execute on function slack_router_decide(text, text, uuid) from public, anon, authenticated;
grant execute on function slack_router_decide(text, text, uuid) to service_role;

insert into reminder_rules (key, enabled, audience, channel_or_dm, timing, template, urgent, quiet_hours_respected) values
  ('request_approval', true, 'owner', 'dm', 'when a client request for tech or the media buyer is classified', 'Client request to approve', true, false),
  ('missed_deadline', true, 'owner', 'dm', 'once, the minute a task or tech job of tech or the media buyer passes its deadline', 'Missed deadline', true, false)
on conflict (key) do nothing;

-- Missed deadlines, for Aryan. A paused tech job (waiting on the client) is not missed.
create function missed_deadline_enqueue(p_now timestamptz default now()) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer; v_owner uuid := app_role_holder('owner');
begin
  if v_owner is null then return 0; end if;
  insert into notifications (rule_key, staff_id, record_type, record_id, window_key, payload, created_at)
  select 'missed_deadline', v_owner, 'tasks', t.id, to_char(t.due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI'),
    jsonb_build_object('what', 'task', 'title', t.title, 'who', s.name, 'clinic', c.name, 'due_at', t.due_at), p_now
  from tasks t
  join staff s on s.id = t.owner_id and s.role in ('tech', 'media_buyer') and s.status <> 'left'
  left join clients c on c.id = t.client_id
  where t.deleted_at is null and t.status <> 'done' and t.due_at is not null
    and t.due_at <= p_now and t.due_at > p_now - interval '7 days'
  on conflict do nothing;
  get diagnostics n = row_count;
  insert into notifications (rule_key, staff_id, record_type, record_id, window_key, payload, created_at)
  select 'missed_deadline', v_owner, 'tech_jobs', j.id, to_char(j.due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI'),
    jsonb_build_object('what', 'tech job', 'title', j.title, 'who', s.name, 'clinic', c.name, 'due_at', j.due_at), p_now
  from tech_jobs j
  join staff s on s.id = j.owner_id and s.status <> 'left'
  left join clients c on c.id = j.client_id
  left join tech_job_sla q on q.tech_job_id = j.id
  where j.deleted_at is null and j.status <> 'done' and j.due_at is not null
    and coalesce(q.is_overdue, j.due_at <= p_now) and not coalesce(q.is_paused, false)
    and j.due_at > p_now - interval '7 days'
  on conflict do nothing;
  return n + (select count(*) from notifications where rule_key = 'missed_deadline' and record_type = 'tech_jobs' and created_at = p_now);
end $$;
revoke execute on function missed_deadline_enqueue(timestamptz) from public, anon, authenticated;
grant execute on function missed_deadline_enqueue(timestamptz) to service_role;
