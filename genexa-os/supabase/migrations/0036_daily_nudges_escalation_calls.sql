-- 1. Outcome nudges become daily: 24h after a consult with no outcome the clinic
--    gets it in one batched message at 10:00 its own time; at 48h a second,
--    shorter reminder. Two reminders per consult, never more.
alter table appointments add column nudge1_at timestamptz;
alter table appointments add column nudge2_at timestamptz;

drop view outcome_nudges_due;
create view outcome_nudges_due with (security_invoker = true) as
with c as (
  select cl.id as client_id, cl.name, coalesce(cl.slack_scheduling_id, cl.slack_general_id) as channel,
    coalesce(cl.timezone, 'America/New_York') as timezone
  from clients cl where cl.deleted_at is null and cl.stage = 'live'
),
a as (
  select ap.id, ap.client_id, ap.scheduled_for, coalesce(ap.contact_first_name, 'Patient') as first_name,
    case
      when ap.nudge1_at is null and ap.scheduled_for < now() - interval '24 hours' then 'first'
      when ap.nudge1_at is not null and ap.nudge2_at is null
        and ap.scheduled_for < now() - interval '48 hours' and ap.nudge1_at < now() - interval '20 hours' then 'second'
    end as stage
  from appointments ap
  -- Only consults that can be checked: a phone on the booking, so a logged outcome would have matched.
  where ap.attendance = 'scheduled' and ap.contact_key is not null and ap.scheduled_for > now() - interval '21 days'
)
select
  c.client_id, c.name, c.channel, c.timezone,
  extract(hour from (now() at time zone c.timezone))::int as local_hour,
  (now() at time zone c.timezone)::date as local_date,
  count(*) filter (where a.stage = 'first') as first_count,
  count(*) filter (where a.stage = 'second') as second_count,
  string_agg(a.first_name || ' — ' || to_char(a.scheduled_for at time zone c.timezone, 'Dy FMDD Mon, FMHH12:MIam'), E'\n' order by a.scheduled_for)
    filter (where a.stage = 'first') as first_list,
  string_agg(a.first_name || ' (' || to_char(a.scheduled_for at time zone c.timezone, 'Dy FMDD Mon') || ')', ', ' order by a.scheduled_for)
    filter (where a.stage = 'second') as second_list,
  array_agg(a.id) filter (where a.stage = 'first') as first_ids,
  array_agg(a.id) filter (where a.stage = 'second') as second_ids
from c join a on a.client_id = c.client_id
where a.stage is not null
group by c.client_id, c.name, c.channel, c.timezone;

update reminder_rules
set timing = 'Daily at 10:00 clinic time: first notice 24h after a consult with no outcome, a shorter second one at 48h',
    template = 'N consults need an outcome (first names and appointment times)'
where key = 'outcome_nudge';

-- ---------------------------------------------------------------------------
-- 2. An angry follow-up on a request already logged raises it to urgent and
--    tells the owner, once per request.
-- ---------------------------------------------------------------------------
alter table client_requests add column escalated_at timestamptz;

create function client_request_escalate() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o client_requests;
  v_owner uuid := app_role_holder('owner');
  v_clinic text;
  v_exception uuid;
begin
  if new.status <> 'merged' or old.status = 'merged' or new.merged_into is null
     or new.urgency is distinct from 'urgent' or new.mode <> 'live' then
    return new;
  end if;
  select * into o from client_requests where id = new.merged_into for update;
  if o.id is null or o.escalated_at is not null then return new; end if;

  update client_requests set escalated_at = now(), urgency = 'urgent' where id = o.id;
  if o.routed_table = 'tasks' then
    update tasks set priority = 'high' where id = o.routed_id;
  elsif o.routed_table = 'exceptions' then
    update exceptions set severity = 'red' where id = o.routed_id;
  end if;

  select name into v_clinic from clients where id = o.client_id;
  insert into exceptions (type, client_id, owner_id, severity, reason, record_table, record_id, dedupe_key, source_url, notes)
  values ('client_escalation', o.client_id, v_owner, 'red',
          v_clinic || ': follow-up on "' || coalesce(o.title, 'a request') || '" is urgent (upset, refund or cancelling)',
          'client_requests', o.id, 'client_escalation:' || o.id, new.permalink, new.text)
  returning id into v_exception;
  insert into notifications (rule_key, staff_id, record_type, record_id, payload)
  values ('exception_opened', v_owner, 'exceptions', v_exception,
          jsonb_build_object('reason', v_clinic || ': urgent follow-up on "' || coalesce(o.title, 'a request') || '"',
                             'severity', 'red', 'type', 'client_escalation', '_urgent', true))
  on conflict do nothing;
  return new;
end $$;
create trigger client_request_escalate after update of status on client_requests
  for each row execute function client_request_escalate();

-- ---------------------------------------------------------------------------
-- 3. Fathom calls a person has sorted out stay sorted: the sync leaves them alone.
-- ---------------------------------------------------------------------------
alter table fathom_calls drop constraint fathom_calls_kind_check;
alter table fathom_calls add constraint fathom_calls_kind_check check (kind in ('client', 'prospect', 'internal', 'unmatched', 'ignored'));
alter table fathom_calls add column resolved_by uuid references staff(id);
create trigger fathom_calls_audit after update on fathom_calls for each row execute function audit_row();
