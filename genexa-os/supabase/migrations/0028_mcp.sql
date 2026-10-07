-- Genexa OS: the MCP endpoint (/api/mcp).
-- Depends on nothing above 0024.
--
-- Reads (mcp_get_*): each returns one jsonb document assembled from the existing
-- views and functions. Nothing is recomputed here beyond totals over those views;
-- a missing number stays null. No patient names, phones or emails, and no
-- prospect contact details, leave through these functions.
--
-- Writes: security definer, and each one first sets app.actor = 'claude' for the
-- transaction so audit_row() records who wrote. There is no delete function.
--
-- Every mcp_* function is executable by service_role only (bottom of this file).
-- Errors a caller can act on are raised with a code prefix:
--   MCP_NOT_FOUND / MCP_AMBIGUOUS / MCP_INVALID, plus the TASK_* codes of tasks_rules.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- A staff member from an id or a name. A name matches the whole name first, then
-- the first name ("Amanda" -> "Amanda Harder"). People who have left never match.
create function mcp_resolve_staff(p_owner text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_key text := lower(btrim(coalesce(p_owner, '')));
  v_ids uuid[];
begin
  if v_key = '' then
    raise exception 'MCP_INVALID: owner is required' using errcode = 'P0001';
  end if;
  if v_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select array_agg(id) into v_ids from staff where id = v_key::uuid and status <> 'left';
  else
    select array_agg(id) into v_ids from staff where lower(btrim(name)) = v_key and status <> 'left';
    if v_ids is null then
      select array_agg(id) into v_ids from staff
      where lower(split_part(btrim(name), ' ', 1)) = v_key and status <> 'left';
    end if;
  end if;
  if v_ids is null then
    raise exception 'MCP_NOT_FOUND: no staff member matches "%"', btrim(p_owner) using errcode = 'P0001';
  end if;
  if array_length(v_ids, 1) > 1 then
    raise exception 'MCP_AMBIGUOUS: more than one staff member matches "%" - use the full name or the id', btrim(p_owner)
      using errcode = 'P0001';
  end if;
  return (select jsonb_build_object('id', s.id, 'name', s.name, 'role', s.role) from staff s where s.id = v_ids[1]);
end $$;

create function mcp_require_client(p_client_id uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from clients where id = p_client_id and deleted_at is null) then
    raise exception 'MCP_NOT_FOUND: no client with id %', p_client_id using errcode = 'P0001';
  end if;
  return p_client_id;
end $$;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------
-- Overview: overview_period for the period and the one before it, MRR from
-- client_fees, open exceptions, clients by stage. "history" says how far back
-- the ad and event data go, so a comparison against an unloaded period can be
-- recognised as such.
create function mcp_get_overview(p_from date, p_to date, p_prev_from date, p_prev_to date) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'current', (select to_jsonb(o) from overview_period(p_from, p_to) o),
    'previous', (select to_jsonb(o) from overview_period(p_prev_from, p_prev_to) o),
    'history', jsonb_build_object(
      'ad_spend_from', (select min(d.date) from ad_metrics_daily d),
      'events_from', (select app_day(min(e.occurred_at)) from cortana_events e)),
    'mrr', (
      select jsonb_build_object(
        'total', sum(f.monthly_fee),
        'clients', count(*),
        'priced_from_whop', count(*) filter (where f.source = 'whop'),
        'target', config_value('mrr_target'))
      from client_fees f),
    'exceptions', (
      select jsonb_build_object('open', count(*), 'money_at_risk', sum(e.money_at_risk))
      from exceptions e where e.status = 'open'),
    'clients_by_stage', (
      select coalesce(jsonb_object_agg(s.stage, s.n), '{}'::jsonb)
      from (select stage, count(*) as n from clients where deleted_at is null group by stage) s),
    'sources', (
      select coalesce(jsonb_agg(jsonb_build_object('source', f.source, 'freshness', f.freshness) order by f.source), '[]'::jsonb)
      from source_freshness f))
$$;

-- Every non-deleted client (or one), churned last.
create function mcp_get_clients(p_client_id uuid default null) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(x.j order by x.churned, x.name), '[]'::jsonb)
  from (
    select c.name, (c.stage = 'churned') as churned,
      jsonb_build_object(
        'id', c.id, 'name', c.name, 'stage', c.stage, 'pod', c.pod, 'launch_date', c.launch_date,
        'health', case when h.client_id is null then null
          else jsonb_build_object('colour', h.colour, 'reasons', h.reasons) end,
        'fee', case when f.client_id is null then null
          else jsonb_build_object('monthly_fee', f.monthly_fee, 'source', f.source) end,
        'renewal', case when r.client_id is null then null
          else jsonb_build_object('date', r.renewal_date, 'status', r.status, 'amount', r.renewal_amount,
            'days_until', r.days_until, 'source', r.source) end,
        'this_month', case when m.client_id is null then null else to_jsonb(m) - 'client_id' end,
        'next_action', c.next_action,
        'last_contact_us', c.last_contact_us,
        'last_reply_client', c.last_reply_client,
        'cortana_connected', (c.cortana_business_id is not null),
        'ads_unverified', exists (select 1 from clients_ads_unverified u where u.client_id = c.id)
      ) as j
    from clients c
    left join client_health h on h.client_id = c.id
    left join client_fees f on f.client_id = c.id
    left join renewals r on r.client_id = c.id
    left join client_mtd m on m.client_id = c.id
    where c.deleted_at is null and (p_client_id is null or c.id = p_client_id)
  ) x
$$;

-- One client: the list row plus what is open on it.
create function mcp_get_client(p_client_id uuid) returns jsonb
language plpgsql stable set search_path = public as $$
begin
  perform mcp_require_client(p_client_id);
  return (mcp_get_clients(p_client_id) -> 0) || jsonb_build_object(
    'open_exceptions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', e.id, 'type', e.type, 'severity', e.severity, 'status', e.status, 'reason', e.reason,
        'money_at_risk', e.money_at_risk, 'first_detected_at', e.first_detected_at,
        'snoozed_until', e.snoozed_until, 'action_taken', e.action_taken, 'owner', o.name)
        order by e.money_at_risk desc nulls last, e.first_detected_at), '[]'::jsonb)
      from exceptions e left join staff o on o.id = e.owner_id
      where e.client_id = p_client_id and e.status in ('open', 'snoozed')),
    'tech_jobs', (
      select coalesce(jsonb_agg(t.j), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'id', b.tech_job_id, 'type', b.type, 'title', b.title, 'status', b.status, 'owner', b.owner_name,
          'requested_at', b.requested_at, 'due_at', b.due_at, 'done_at', b.done_at, 'blocked_on', b.blocked_on,
          'sla_minutes', b.sla_minutes, 'genexa_minutes', b.genexa_minutes, 'paused_minutes', b.paused_minutes,
          'is_paused', b.is_paused, 'is_overdue', b.is_overdue, 'met_sla', b.met_sla) as j
        from tech_jobs_board b
        where b.client_id = p_client_id
        order by b.requested_at desc
        limit 50
      ) t),
    'recent_touches', (
      select coalesce(jsonb_agg(t.j), '[]'::jsonb)
      from (
        select jsonb_build_object('id', tc.id, 'at', tc.at, 'kind', tc.kind, 'by', s.name, 'note', tc.note) as j
        from touches tc left join staff s on s.id = tc.by_id
        where tc.client_id = p_client_id and tc.deleted_at is null
        order by tc.at desc
        limit 20
      ) t));
end $$;

-- Ad numbers for one clinic. Account level for the window asked for (p_days null
-- = all time); ad level as Cortana reports it, which is 7 days and all time only.
create function mcp_get_ad_metrics(p_client_id uuid, p_days int default null) returns jsonb
language plpgsql stable set search_path = public as $$
begin
  perform mcp_require_client(p_client_id);
  return jsonb_build_object(
    'client_id', p_client_id,
    'account', (select to_jsonb(a) - 'client_id' from media_account_metrics(p_days) a where a.client_id = p_client_id),
    'ads', (
      select coalesce(jsonb_agg(to_jsonb(m) - 'client_id' - 'client_name' order by m.spend_7d desc nulls last, m.ad_name), '[]'::jsonb)
      from media_ad_metrics m where m.client_id = p_client_id));
end $$;

-- Exceptions in one status, biggest money at risk first. At most 500 rows.
create function mcp_get_exceptions(p_status text default 'open') returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'status', p_status,
    'count', count(*),
    'money_at_risk', sum(x.money_at_risk),
    'exceptions', coalesce(jsonb_agg(x.j order by x.money_at_risk desc nulls last, x.first_detected_at), '[]'::jsonb))
  from (
    select e.money_at_risk, e.first_detected_at,
      jsonb_build_object(
        'id', e.id, 'type', e.type, 'severity', e.severity, 'status', e.status, 'reason', e.reason,
        'money_at_risk', e.money_at_risk, 'client_id', e.client_id, 'client', c.name, 'owner', o.name,
        'first_detected_at', e.first_detected_at, 'last_detected_at', e.last_detected_at,
        'snoozed_until', e.snoozed_until, 'snooze_reason', e.snooze_reason, 'action_taken', e.action_taken,
        'resolved_at', e.resolved_at, 'resolved_by', e.resolved_by, 'resolution_note', e.resolution_note) as j
    from exceptions e
    left join clients c on c.id = e.client_id
    left join staff o on o.id = e.owner_id
    where e.status = p_status
    order by e.last_detected_at desc
    limit 500
  ) x
$$;

-- Tech jobs with their SLA figures. p_status null = everything not done.
create function mcp_get_tech_jobs(p_status text default null) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(x.j), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', b.tech_job_id, 'type', b.type, 'title', b.title, 'notes', b.notes, 'status', b.status,
      'client_id', b.client_id, 'client', b.client_name, 'owner', b.owner_name, 'requested_by', b.requested_by_name,
      'requested_at', b.requested_at, 'due_at', b.due_at, 'done_at', b.done_at, 'blocked_on', b.blocked_on,
      'broke_after_live', b.broke_after_live,
      'sla_minutes', b.sla_minutes, 'genexa_minutes', b.genexa_minutes, 'paused_minutes', b.paused_minutes,
      'pause_count', b.pause_count, 'is_paused', b.is_paused, 'is_overdue', b.is_overdue, 'met_sla', b.met_sla,
      'pause_reason', b.pause_reason, 'paused_at', b.paused_at) as j
    from tech_jobs_board b
    where case when p_status is null then b.status <> 'done' else b.status = p_status end
    order by b.is_overdue desc, b.due_at nulls last, b.requested_at desc
    limit 300
  ) x
$$;

create function mcp_get_launches() returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(
    to_jsonb(b) - 'owner_id' - 'pause_id' - 'next_stage' - 'prev_stage'
    order by b.stage_order, b.days_waiting desc nulls last, b.client_name), '[]'::jsonb)
  from launch_board b
$$;

-- Scorecards for one ET week (Monday). Null = the current week.
create function mcp_get_scores(p_week date default null) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'week_start', w.d,
    'scores', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'staff_id', p.staff_id, 'name', s.name, 'role', s.role, 'card', p.card, 'metric', p.metric,
        'value', p.value, 'numerator', p.numerator, 'denominator', p.denominator, 'colour', p.colour,
        'is_baseline', p.is_baseline) order by s.name, p.card, p.metric), '[]'::jsonb)
      from person_scores_weekly p join staff s on s.id = p.staff_id
      where p.week_start = w.d))
  from (select coalesce(p_week, app_week_start(app_today())) as d) w
$$;

create function mcp_get_eods(p_from date, p_to date) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'staff_id', e.staff_id, 'name', s.name, 'date', e.date, 'role', e.role, 'answers', e.answers,
    'submitted_at', e.submitted_at) order by e.date desc, s.name), '[]'::jsonb)
  from eods e join staff s on s.id = e.staff_id
  where e.date between p_from and p_to
$$;

-- Open tasks (not deleted, not in the Done group), one entry per owner.
-- With no owner, only people who have something open are listed.
create function mcp_get_tasks(p_owner text default null) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_owner uuid;
begin
  if p_owner is not null then
    v_owner := (mcp_resolve_staff(p_owner) ->> 'id')::uuid;
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'owner_id', o.owner_id, 'owner', o.name, 'role', o.role,
      'open_tasks', o.open_tasks, 'overdue_tasks', o.overdue_tasks,
      'tasks', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', t.id, 'title', t.title, 'category', t.category, 'priority', t.priority, 'status', t.status,
          'group', t.task_group, 'due', t.due, 'days_overdue', t.days_overdue, 'client_id', t.client_id,
          'client', t.client_name, 'parent', t.parent_title, 'source', t.source, 'notes', t.notes,
          'created_at', t.created_at) order by t.priority_rank, t.due nulls last, t.created_at), '[]'::jsonb)
        from task_list t where t.owner_id = o.owner_id and t.task_group <> 'done')
      ) order by o.name), '[]'::jsonb)
    from task_owners o
    where case when v_owner is null then o.open_tasks > 0 else o.owner_id = v_owner end);
end $$;

-- Prospects. The contact column is deliberately not selected.
create function mcp_get_prospects() returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'name', p.name, 'heat', p.heat, 'state', p.state, 'stage', p.stage, 'call_date', p.call_date,
    'what_they_want', p.what_they_want, 'objection', p.objection, 'promised', p.promised,
    'follow_up_date', p.follow_up_date, 'follow_up_days_overdue', f.days_overdue,
    'fathom_url', p.fathom_url, 'deal_size', p.deal_size, 'updated_at', p.updated_at)
    order by case p.stage when 'chase' then 1 when 'contract_out' then 2 when 'paid' then 3 else 4 end,
      case p.heat when 'hot' then 1 when 'warm' then 2 when 'cold' then 3 else 4 end, p.name), '[]'::jsonb)
  from prospects p
  left join prospect_follow_ups f on f.id = p.id
  where p.deleted_at is null
$$;

-- A month of the agency. Frozen snapshot when there is one; otherwise the live
-- figures for the month so far (overview_period) with today's MRR.
create function mcp_get_agency_month(p_month date) returns jsonb
language sql stable set search_path = public as $$
  with m as (
    select date_trunc('month', p_month::timestamp)::date as first_day,
      least((date_trunc('month', p_month::timestamp) + interval '1 month' - interval '1 day')::date, app_today()) as last_day
  )
  select coalesce(
    (select jsonb_build_object('month', to_char(m.first_day, 'YYYY-MM'), 'frozen', true,
        'frozen_at', a.frozen_at, 'snapshot', a.snapshot)
      from agency_month a where a.month = m.first_day and a.frozen_at is not null),
    jsonb_build_object('month', to_char(m.first_day, 'YYYY-MM'), 'frozen', false,
      'from', m.first_day, 'to', m.last_day,
      'figures', (select to_jsonb(o) from overview_period(m.first_day, m.last_day) o),
      'mrr', (select sum(f.monthly_fee) from client_fees f),
      'mrr_as_of', app_today(),
      'whop_recurring_mrr', whop_mrr_at(m.last_day)))
  from m
$$;

create function mcp_get_sync_status() returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(f) order by f.source), '[]'::jsonb) from source_freshness f
$$;

-- What the endpoint checks before it tries to add a task: who the owner is, and
-- whether the title looks like a task that owner deleted (same test as tasks_rules).
create function mcp_task_check(p_owner text, p_title text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_owner jsonb := mcp_resolve_staff(p_owner);
  v_threshold numeric := coalesce(config_value('task_deleted_similarity'), 0.6);
begin
  return jsonb_build_object(
    'owner', v_owner,
    'deleted_match', (
      select jsonb_build_object('title', d.title, 'similarity', round(similarity(lower(d.title), lower(p_title))::numeric, 2))
      from deleted_tasks d
      where d.owner_id = (v_owner ->> 'id')::uuid and similarity(lower(d.title), lower(p_title)) >= v_threshold
      order by similarity(lower(d.title), lower(p_title)) desc
      limit 1));
end $$;

-- ---------------------------------------------------------------------------
-- Writes. Audited as "claude". No deletes.
-- ---------------------------------------------------------------------------
create function mcp_write_brief(p_date date, p_kind text, p_markdown text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row briefs;
  v_created boolean;
begin
  perform set_config('app.actor', 'claude', true);
  if btrim(coalesce(p_markdown, '')) = '' then
    raise exception 'MCP_INVALID: markdown is empty' using errcode = 'P0001';
  end if;
  v_created := not exists (select 1 from briefs where date = p_date and kind = p_kind);
  insert into briefs (date, kind, body_markdown, written_by)
  values (p_date, p_kind, p_markdown, 'claude')
  on conflict (date, kind) do update set body_markdown = excluded.body_markdown, written_by = 'claude'
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'date', v_row.date, 'kind', v_row.kind,
    'written_by', v_row.written_by, 'created', v_created, 'characters', length(v_row.body_markdown));
end $$;

-- The three task rules are enforced by tasks_rules on the insert below:
--   TASK_OWNER_LIST    Ryan's list only takes source = 'pushpin'
--   TASK_CATEGORY      the media buyer's tasks are ads or call_centre
--   TASK_DELETED_MATCH the title matches a task this owner deleted
create function mcp_add_task(
  p_owner text, p_title text, p_category text, p_source text,
  p_client_id uuid default null, p_due date default null, p_notes text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_owner jsonb;
  v_row tasks;
begin
  perform set_config('app.actor', 'claude', true);
  if btrim(coalesce(p_title, '')) = '' then
    raise exception 'MCP_INVALID: title is required' using errcode = 'P0001';
  end if;
  if p_source is null or p_source not in ('pushpin', 'claude', 'call', 'slack', 'system') then
    raise exception 'MCP_INVALID: source must be pushpin, claude, call, slack or system' using errcode = 'P0001';
  end if;
  v_owner := mcp_resolve_staff(p_owner);
  if p_client_id is not null then
    perform mcp_require_client(p_client_id);
  end if;
  insert into tasks (owner_id, title, category, source, client_id, due, notes)
  values ((v_owner ->> 'id')::uuid, btrim(p_title), p_category, p_source, p_client_id, p_due, nullif(btrim(p_notes), ''))
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'owner_id', v_row.owner_id, 'owner', v_owner ->> 'name',
    'title', v_row.title, 'category', v_row.category, 'priority', v_row.priority, 'status', v_row.status,
    'group', v_row.task_group, 'source', v_row.source, 'client_id', v_row.client_id, 'due', v_row.due,
    'notes', v_row.notes);
end $$;

create function mcp_add_idea(p_text text, p_source text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row ideas;
begin
  perform set_config('app.actor', 'claude', true);
  if btrim(coalesce(p_text, '')) = '' then
    raise exception 'MCP_INVALID: text is required' using errcode = 'P0001';
  end if;
  insert into ideas (text, source) values (btrim(p_text), nullif(btrim(p_source), '')) returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'text', v_row.text, 'source', v_row.source, 'created_at', v_row.created_at);
end $$;

-- Create or update a prospect, matched on its name (case-insensitive, live rows).
-- Only the keys present in p_fields are written; the contact column is never
-- written and never returned.
create function mcp_upsert_prospect(p_name text, p_fields jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  f jsonb := coalesce(p_fields, '{}'::jsonb);
  v_bad text;
  v_n int;
  v_id uuid;
  v_created boolean := false;
begin
  perform set_config('app.actor', 'claude', true);
  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'MCP_INVALID: name is required' using errcode = 'P0001';
  end if;
  select string_agg(k, ', ' order by k) into v_bad
  from jsonb_object_keys(f) k
  where k not in ('heat', 'state', 'call_date', 'what_they_want', 'objection', 'promised',
                  'follow_up_date', 'fathom_url', 'deal_size', 'stage');
  if v_bad is not null then
    raise exception 'MCP_INVALID: these prospect fields cannot be written here: %', v_bad using errcode = 'P0001';
  end if;

  select count(*), (array_agg(id order by updated_at desc))[1] into v_n, v_id
  from prospects where deleted_at is null and lower(btrim(name)) = lower(btrim(p_name));
  if v_n > 1 then
    raise exception 'MCP_AMBIGUOUS: % prospects are called "%"', v_n, btrim(p_name) using errcode = 'P0001';
  end if;

  if v_n = 0 then
    insert into prospects (name, heat, state, call_date, what_they_want, objection, promised,
      follow_up_date, fathom_url, deal_size, stage)
    values (btrim(p_name), f ->> 'heat', f ->> 'state', (f ->> 'call_date')::date, f ->> 'what_they_want',
      f ->> 'objection', f ->> 'promised', (f ->> 'follow_up_date')::date, f ->> 'fathom_url',
      (f ->> 'deal_size')::numeric, coalesce(f ->> 'stage', 'chase'))
    returning id into v_id;
    v_created := true;
  else
    update prospects set
      heat = case when f ? 'heat' then f ->> 'heat' else heat end,
      state = case when f ? 'state' then f ->> 'state' else state end,
      call_date = case when f ? 'call_date' then (f ->> 'call_date')::date else call_date end,
      what_they_want = case when f ? 'what_they_want' then f ->> 'what_they_want' else what_they_want end,
      objection = case when f ? 'objection' then f ->> 'objection' else objection end,
      promised = case when f ? 'promised' then f ->> 'promised' else promised end,
      follow_up_date = case when f ? 'follow_up_date' then (f ->> 'follow_up_date')::date else follow_up_date end,
      fathom_url = case when f ? 'fathom_url' then f ->> 'fathom_url' else fathom_url end,
      deal_size = case when f ? 'deal_size' then (f ->> 'deal_size')::numeric else deal_size end,
      stage = case when f ? 'stage' then f ->> 'stage' else stage end
    where id = v_id;
  end if;

  return (
    select jsonb_build_object('created', v_created, 'prospect', jsonb_build_object(
      'id', p.id, 'name', p.name, 'heat', p.heat, 'state', p.state, 'stage', p.stage, 'call_date', p.call_date,
      'what_they_want', p.what_they_want, 'objection', p.objection, 'promised', p.promised,
      'follow_up_date', p.follow_up_date, 'fathom_url', p.fathom_url, 'deal_size', p.deal_size))
    from prospects p where p.id = v_id);
end $$;

create function mcp_set_next_action(p_client_id uuid, p_text text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.actor', 'claude', true);
  perform mcp_require_client(p_client_id);
  if btrim(coalesce(p_text, '')) = '' then
    raise exception 'MCP_INVALID: text is required' using errcode = 'P0001';
  end if;
  update clients set next_action = btrim(p_text) where id = p_client_id;
  return (select jsonb_build_object('client_id', c.id, 'client', c.name, 'next_action', c.next_action)
    from clients c where c.id = p_client_id);
end $$;

-- Logging a touch also moves the clinic's last_contact_us (touches_set_last_contact).
create function mcp_log_touch(p_client_id uuid, p_kind text, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row touches;
begin
  perform set_config('app.actor', 'claude', true);
  perform mcp_require_client(p_client_id);
  if btrim(coalesce(p_note, '')) = '' then
    raise exception 'MCP_INVALID: note is required' using errcode = 'P0001';
  end if;
  insert into touches (client_id, kind, note) values (p_client_id, p_kind, btrim(p_note)) returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'client_id', v_row.client_id, 'kind', v_row.kind, 'at', v_row.at,
    'note', v_row.note,
    'last_contact_us', (select c.last_contact_us from clients c where c.id = p_client_id));
end $$;

create function mcp_set_exception_action(p_id uuid, p_text text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.actor', 'claude', true);
  if not exists (select 1 from exceptions where id = p_id) then
    raise exception 'MCP_NOT_FOUND: no exception with id %', p_id using errcode = 'P0001';
  end if;
  if btrim(coalesce(p_text, '')) = '' then
    raise exception 'MCP_INVALID: text is required' using errcode = 'P0001';
  end if;
  update exceptions set action_taken = btrim(p_text) where id = p_id;
  return (select jsonb_build_object('id', e.id, 'type', e.type, 'status', e.status, 'action_taken', e.action_taken)
    from exceptions e where e.id = p_id);
end $$;

-- ---------------------------------------------------------------------------
-- Only the server (service role) may call any of these.
-- ---------------------------------------------------------------------------
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'mcp\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
