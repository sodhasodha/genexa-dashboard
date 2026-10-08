-- Triage clears itself when we have already replied in Slack.
--
-- A Triage item is a client message the router was not sure about. If a Genexa
-- staff member then replies in that message's thread, or posts in the same client
-- channel after it, the item is marked "Handled in Slack" and leaves the queue.
-- Nothing is deleted: the row stays, with who handled it, when, and which Slack
-- message did it. Only 'triage' rows ever change; routed work, requests awaiting
-- approval and everything else are left alone.
--
-- Nothing else depends on the list of statuses: router_accuracy counts by
-- classified_at, the Triage queue reads status = 'triage', and route_client_request /
-- router_decide refuse anything that is not 'new' / 'triage' / 'pending_approval',
-- so a handled row cannot be routed or decided on afterwards.
-- The table's grants and row level security (0035) already cover the new columns.

alter table client_requests drop constraint client_requests_status_check;
alter table client_requests add constraint client_requests_status_check
  check (status in ('new', 'not_request', 'routed', 'merged', 'triage', 'pending_approval', 'rejected', 'handled'));

alter table client_requests
  add column handled_at timestamptz,
  add column handled_reason text,
  -- The staff member's name, or their Slack user id when the name is not known.
  add column handled_by text,
  -- The Slack ts of the staff message that handled it.
  add column handled_ts text;

create index client_requests_handled_idx on client_requests (handled_at desc) where status = 'handled';

-- A staff message at p_ts in p_channel. Handles every Triage row in that channel that is
--   (a) a thread reply (p_thread_ts set): the thread's root, or an earlier message in that thread;
--   (b) a post in the channel itself: sent before it.
-- Slack timestamps are compared as numbers. Returns how many rows changed; calling
-- it again for the same message changes nothing.
create function router_mark_handled(p_channel text, p_ts text, p_thread_ts text default null, p_by text default null) returns integer
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
  where r.channel = p_channel and r.status = 'triage'
    and case
      when v_thread is not null then
        r.slack_ts = v_thread or (r.thread_ts = v_thread and r.slack_ts::numeric < p_ts::numeric)
      else r.slack_ts::numeric < p_ts::numeric
    end;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- What the sweep has to look at: every channel with open Triage rows, the oldest
-- of them (where to start reading the channel from) and the threads they are in.
create function router_open_triage() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x.item order by x.client_name, x.channel), '[]'::jsonb)
  from (
    select c.name as client_name, r.channel,
      jsonb_build_object(
        'channel', r.channel,
        'client_name', c.name,
        'open', count(*),
        'oldest_ts', (array_agg(r.slack_ts order by r.slack_ts::numeric))[1],
        -- A row that is not in a thread may be the root of one.
        'roots', jsonb_agg(distinct r.slack_ts) filter (where r.thread_ts is null),
        'threads', coalesce(jsonb_agg(distinct r.thread_ts) filter (where r.thread_ts is not null), '[]'::jsonb)) as item
    from client_requests r
    join clients c on c.id = r.client_id
    where r.status = 'triage'
    group by c.name, r.channel
  ) x
$$;

do $$
declare f text;
begin
  -- Server-side only (webhook, jobs, scripts).
  foreach f in array array['router_mark_handled(text, text, text, text)', 'router_open_triage()'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
