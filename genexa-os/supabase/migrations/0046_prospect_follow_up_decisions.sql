-- Close a prospect follow-up without doing it.
--
--   "Not following up"  the prospect goes to Dead with a reason, its follow-up date is
--                       cleared, and every reminder about it stops.
--   "Follow up later"   a new follow-up date; reminders pause until that day.
--   Undo                puts the stage and the follow-up date back as they were.
--
-- Each decision is a row in prospect_follow_up_decisions, so it can be read back and undone.
--
-- Reminders: reminder_candidates (prospect_follow_up) and reminder_morning_digest (0027) and
-- the prospect_follow_ups view (0018) already key off stage in (chase, contract_out) and the
-- follow-up date, so a dead prospect or one with a later date drops out of all three with no
-- change to them. What they did not cover is a reminder that was already queued and not yet
-- sent (held for a shift): the trigger at the bottom closes those.
-- Nothing from 0027 is redefined here.

create table prospect_follow_up_decisions (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  kind text not null check (kind in ('not_following_up', 'follow_up_later')),
  reason text check (reason in ('not_a_fit', 'went_elsewhere', 'gone_cold', 'other')),
  reason_text text,
  previous_stage text not null check (previous_stage in ('chase', 'contract_out', 'paid', 'dead')),
  previous_follow_up_date date,
  new_follow_up_date date,
  decided_by uuid not null references staff(id),
  decided_at timestamptz not null default now(),
  source text not null default 'app' check (source in ('app', 'slack')),
  undone_at timestamptz,
  undone_by uuid references staff(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'not_following_up') = (reason is not null)),
  check (reason is distinct from 'other' or btrim(coalesce(reason_text, '')) <> ''),
  check ((kind = 'follow_up_later') = (new_follow_up_date is not null)),
  check ((undone_at is null) = (undone_by is null))
);
create index prospect_follow_up_decisions_prospect_idx on prospect_follow_up_decisions (prospect_id, decided_at desc);

create trigger prospect_follow_up_decisions_set_updated_at before update on prospect_follow_up_decisions for each row execute function set_updated_at();
create trigger prospect_follow_up_decisions_forbid_delete before delete on prospect_follow_up_decisions for each row execute function forbid_delete();
create trigger prospect_follow_up_decisions_audit after insert or update on prospect_follow_up_decisions for each row execute function audit_row();
alter table prospect_follow_up_decisions enable row level security;
create policy owner_all on prospect_follow_up_decisions for all to authenticated using (app_is_owner()) with check (app_is_owner());
create policy staff_read on prospect_follow_up_decisions for select to authenticated using (app_staff_id() is not null);
revoke all on prospect_follow_up_decisions from anon;
grant select, insert, update on prospect_follow_up_decisions to authenticated;
grant all on prospect_follow_up_decisions to service_role;

-- ---------------------------------------------------------------------------
-- The history shown on the prospect's page. is_undoable is true for one row at
-- most per prospect: the latest decision not yet undone, and only while the
-- prospect is still as that decision left it (so an undo never overwrites a
-- change made by hand afterwards).
-- ---------------------------------------------------------------------------
create view prospect_follow_up_decision_log with (security_invoker = true) as
select
  d.id, d.prospect_id, d.kind, d.reason, d.reason_text,
  d.previous_stage, d.previous_follow_up_date, d.new_follow_up_date,
  d.decided_by, s.name as decided_by_name, d.decided_at, d.source,
  d.undone_at, d.undone_by, u.name as undone_by_name,
  (d.undone_at is null
    and p.deleted_at is null
    and not exists (
      select 1 from prospect_follow_up_decisions x
      where x.prospect_id = d.prospect_id and x.undone_at is null
        and (x.decided_at, x.id) > (d.decided_at, d.id))
    and case d.kind
          when 'not_following_up' then p.stage = 'dead'
          else p.stage = d.previous_stage and p.follow_up_date is not distinct from d.new_follow_up_date
        end) as is_undoable
from prospect_follow_up_decisions d
join prospects p on p.id = d.prospect_id
join staff s on s.id = d.decided_by
left join staff u on u.id = d.undone_by;

revoke all on prospect_follow_up_decision_log from anon;
grant select on prospect_follow_up_decision_log to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Who is deciding. A logged-in user must be the app owner and acts as themselves
-- (p_actor is ignored, so it cannot be used to act as someone else). The server
-- (service role: no user id) must name the actor, who must be the app owner.
-- Returns null when the caller may not decide.
-- ---------------------------------------------------------------------------
create function prospect_decision_actor(p_actor uuid) returns uuid
language plpgsql stable as $$
declare v uuid;
begin
  if auth.uid() is not null then
    if not app_is_owner() then return null; end if;
    return app_staff_id();
  end if;
  select s.id into v from staff s where s.id = p_actor and s.role = 'owner' and s.status <> 'left';
  return v;
end $$;

-- The audit log names the person: a logged-in user is named by audit_row itself.
create function prospect_decision_audit_as(p_actor uuid) returns void
language plpgsql as $$
begin
  if auth.uid() is null then
    perform set_config('app.actor', coalesce((select name from staff where id = p_actor), ''), true);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- "Not following up": stage dead, follow-up date cleared, reason stored.
-- Returns { result, name } with result one of:
--   not_following_up, refused, not_found, not_open (already paid or dead),
--   invalid_reason, reason_text_required.
-- ---------------------------------------------------------------------------
create function prospect_not_following_up(p_prospect uuid, p_reason text, p_reason_text text default null,
                                          p_actor uuid default null, p_source text default 'app') returns jsonb
language plpgsql as $$
declare
  v_actor uuid := prospect_decision_actor(p_actor);
  p prospects%rowtype;
  v_text text := nullif(btrim(coalesce(p_reason_text, '')), '');
begin
  if v_actor is null then return jsonb_build_object('result', 'refused'); end if;
  select * into p from prospects where id = p_prospect and deleted_at is null for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  if p.stage not in ('chase', 'contract_out') then
    return jsonb_build_object('result', 'not_open', 'name', p.name, 'stage', p.stage);
  end if;
  if p_reason is null or p_reason not in ('not_a_fit', 'went_elsewhere', 'gone_cold', 'other') then
    return jsonb_build_object('result', 'invalid_reason', 'name', p.name);
  end if;
  if p_reason = 'other' and v_text is null then
    return jsonb_build_object('result', 'reason_text_required', 'name', p.name);
  end if;

  perform prospect_decision_audit_as(v_actor);
  insert into prospect_follow_up_decisions (prospect_id, kind, reason, reason_text, previous_stage, previous_follow_up_date, decided_by, source)
  values (p.id, 'not_following_up', p_reason, v_text, p.stage, p.follow_up_date, v_actor,
    case when p_source = 'slack' then 'slack' else 'app' end);
  update prospects set stage = 'dead', follow_up_date = null where id = p.id;
  update notifications n set acknowledged_at = now()
  where n.record_type = 'prospects' and n.record_id = p.id and n.sent_at is not null and n.acknowledged_at is null;
  if auth.uid() is null then perform set_config('app.actor', '', true); end if;
  return jsonb_build_object('result', 'not_following_up', 'name', p.name, 'reason', p_reason);
end $$;

-- ---------------------------------------------------------------------------
-- "Follow up later": a new follow-up date after today (ET). The stage stays.
-- Returns { result, name, date } with result one of:
--   follow_up_later, refused, not_found, not_open, date_not_future.
-- ---------------------------------------------------------------------------
create function prospect_follow_up_later(p_prospect uuid, p_date date, p_actor uuid default null,
                                         p_source text default 'app') returns jsonb
language plpgsql as $$
declare
  v_actor uuid := prospect_decision_actor(p_actor);
  p prospects%rowtype;
begin
  if v_actor is null then return jsonb_build_object('result', 'refused'); end if;
  select * into p from prospects where id = p_prospect and deleted_at is null for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  if p.stage not in ('chase', 'contract_out') then
    return jsonb_build_object('result', 'not_open', 'name', p.name, 'stage', p.stage);
  end if;
  if p_date is null or p_date <= app_today() then
    return jsonb_build_object('result', 'date_not_future', 'name', p.name);
  end if;

  perform prospect_decision_audit_as(v_actor);
  insert into prospect_follow_up_decisions (prospect_id, kind, previous_stage, previous_follow_up_date, new_follow_up_date, decided_by, source)
  values (p.id, 'follow_up_later', p.stage, p.follow_up_date, p_date, v_actor,
    case when p_source = 'slack' then 'slack' else 'app' end);
  update prospects set follow_up_date = p_date where id = p.id;
  update notifications n set acknowledged_at = now()
  where n.record_type = 'prospects' and n.record_id = p.id and n.sent_at is not null and n.acknowledged_at is null;
  if auth.uid() is null then perform set_config('app.actor', '', true); end if;
  return jsonb_build_object('result', 'follow_up_later', 'name', p.name, 'date', p_date);
end $$;

-- ---------------------------------------------------------------------------
-- Undo the latest decision: the stage and follow-up date go back to what they
-- were. Returns { result, name, stage, follow_up_date } with result one of:
--   undone, refused, not_found, nothing_to_undo.
-- ---------------------------------------------------------------------------
create function prospect_follow_up_undo(p_prospect uuid, p_actor uuid default null) returns jsonb
language plpgsql as $$
declare
  v_actor uuid := prospect_decision_actor(p_actor);
  p prospects%rowtype;
  d prospect_follow_up_decision_log%rowtype;
begin
  if v_actor is null then return jsonb_build_object('result', 'refused'); end if;
  select * into p from prospects where id = p_prospect and deleted_at is null for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  select * into d from prospect_follow_up_decision_log l where l.prospect_id = p.id and l.is_undoable;
  if not found then return jsonb_build_object('result', 'nothing_to_undo', 'name', p.name); end if;

  perform prospect_decision_audit_as(v_actor);
  update prospects set stage = d.previous_stage, follow_up_date = d.previous_follow_up_date where id = p.id;
  update prospect_follow_up_decisions set undone_at = now(), undone_by = v_actor where id = d.id;
  if auth.uid() is null then perform set_config('app.actor', '', true); end if;
  return jsonb_build_object('result', 'undone', 'name', p.name, 'kind', d.kind,
    'stage', d.previous_stage, 'follow_up_date', d.previous_follow_up_date);
end $$;

-- ---------------------------------------------------------------------------
-- The two controls on the Slack reminder. Only the app owner may act.
-- Returns what the function above returns, plus actor; or
--   { result: unknown_user | bad_request | refused }.
-- ---------------------------------------------------------------------------
create function slack_prospect_action(p_slack_user text, p_action text, p_prospect uuid,
                                      p_reason text default null, p_date date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v staff%rowtype;
  r jsonb;
begin
  select * into v from staff where slack_user_id = p_slack_user and status <> 'left' order by created_at limit 1;
  if not found then return jsonb_build_object('result', 'unknown_user'); end if;
  if p_action not in ('not_following_up', 'follow_up_later') then
    return jsonb_build_object('result', 'bad_request', 'actor', v.name);
  end if;
  if v.role <> 'owner' then return jsonb_build_object('result', 'refused', 'actor', v.name); end if;

  if p_action = 'not_following_up' then
    r := prospect_not_following_up(p_prospect, p_reason,
      case when p_reason = 'other' then 'Chosen in Slack' end, v.id, 'slack');
  else
    r := prospect_follow_up_later(p_prospect, p_date, v.id, 'slack');
  end if;
  return r || jsonb_build_object('actor', v.name);
end $$;

-- ---------------------------------------------------------------------------
-- A reminder already queued for a prospect must not go out once the prospect
-- no longer needs following up today: it is dead or paid, removed, or its
-- follow-up date has moved past today (ET). The row is closed the way
-- reminders_deliverable closes a resolved record ('skipped:resolved'), and the
-- prospect is taken off any morning digest still waiting to be sent.
-- Fires for every way a prospect changes (the two controls, the stage dropdown,
-- the date box, the MCP), so none of them can leave a stale reminder queued.
-- ---------------------------------------------------------------------------
create function prospects_close_reminders() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.deleted_at is null and new.stage in ('chase', 'contract_out')
     and new.follow_up_date is not null and new.follow_up_date <= app_today() then
    return new;
  end if;

  update notifications n set sent_at = now(), slack_ts = 'skipped:resolved',
    channel = case when n.staff_id is null then n.channel else 'skipped:resolved' end
  where n.sent_at is null and n.rule_key = 'prospect_follow_up'
    and n.record_type = 'prospects' and n.record_id = new.id;

  update notifications n set payload = jsonb_set(n.payload, '{prospects}', (
      select coalesce(jsonb_agg(x.item order by x.ord), '[]'::jsonb)
      from jsonb_array_elements(n.payload -> 'prospects') with ordinality x(item, ord)
      where x.item ->> 'id' <> new.id::text))
  where n.sent_at is null and n.rule_key = 'ryan_morning_digest'
    and jsonb_typeof(n.payload -> 'prospects') = 'array'
    and n.payload -> 'prospects' @> jsonb_build_array(jsonb_build_object('id', new.id));
  return new;
end $$;

create trigger prospects_close_reminders after update of stage, follow_up_date, deleted_at on prospects
  for each row execute function prospects_close_reminders();

-- Who may call what. The owner calls the three decision functions as themselves
-- (row level security and the audit log apply); the Slack handler is server only.
do $$
declare f text;
begin
  foreach f in array array[
    'prospect_decision_actor(uuid)', 'prospect_decision_audit_as(uuid)',
    'prospect_not_following_up(uuid, text, text, uuid, text)', 'prospect_follow_up_later(uuid, date, uuid, text)',
    'prospect_follow_up_undo(uuid, uuid)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  foreach f in array array['slack_prospect_action(text, text, uuid, text, date)', 'prospects_close_reminders()'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
