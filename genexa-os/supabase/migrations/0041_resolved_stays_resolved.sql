-- 1. A bottleneck a person resolved stays resolved, even while its rule still
--    matches. It comes back, as a NEW bottleneck, only when something changes:
--      * the condition cleared and later returned;
--      * it got worse: amber -> red, money at risk up by more than a quarter,
--        or $0 spend resolved in its first days and still $0 three days on;
--      * it is a new renewal period (the period is part of the key).
--    Snooze is unchanged: hidden until a time, then back.
alter table exceptions add column held boolean not null default false;
alter table exceptions add column hold_released_at timestamptz;
alter table exceptions add column hold_release_reason text check (hold_release_reason in ('cleared', 'worse'));
alter table exceptions add column escalation integer not null default 0;
create index exceptions_held_idx on exceptions (dedupe_key) where held;

-- Anyone but the engine resolving an exception puts the hold on.
create function exceptions_hold_on_manual_resolve() returns trigger
language plpgsql as $$
begin
  if new.status = 'resolved' and old.status <> 'resolved' and coalesce(new.resolved_by, '') <> 'system' then
    new.held := true;
  end if;
  return new;
end $$;
create trigger exceptions_hold_on_manual_resolve before update on exceptions
  for each row execute function exceptions_hold_on_manual_resolve();

-- Renewals overdue become a bottleneck of their own. One per renewal period:
-- resolving this period's does not silence the next one.
alter view exception_detections rename to exception_detections_core;
create view exception_detections with (security_invoker = true) as
select * from exception_detections_core
union all
select
  'renewal_overdue'::text, 'renewal_overdue:' || r.client_id || ':' || r.renewal_date, r.client_id, null::uuid,
  app_role_holder('owner'), null::text, 'red'::text,
  r.name || ': renewal overdue since ' || to_char(r.renewal_date, 'DD Mon'),
  r.renewal_amount, 'clients'::text, r.client_id
from renewals r
where r.status = 'overdue' and r.stage in ('live', 'onboarding', 'paused');
grant select on exception_detections, exception_detections_core to authenticated, service_role;
insert into exception_rules (type, label, sources, urgent) values ('renewal_overdue', 'Renewal overdue', '{whop}', false)
on conflict (type) do nothing;

create or replace function run_exceptions_engine()
returns table (exception_id uuid, action text, exception_type text)
language plpgsql security definer set search_path = public as $$
declare
  v_stale text[];
begin
  select coalesce(array_agg(f.source), '{}') into v_stale from source_freshness f where f.is_stale;

  drop table if exists _detections;
  create temp table _detections on commit drop as
  select distinct on (d.dedupe_key) d.*
  from exception_detections d
  join exception_rules r on r.type = d.type
  where r.enabled and not (r.sources && v_stale)
  order by d.dedupe_key;

  -- Snoozes that have run out come back as open.
  update exceptions e set status = 'open', snoozed_until = null
  where e.status = 'snoozed' and e.snoozed_until is not null and e.snoozed_until <= now();

  -- Holds let go. Only judged while the rule's data is fresh: a missing
  -- detection during an outage is not "the condition cleared".
  drop table if exists _worse;
  create temp table _worse on commit drop as
  with released as (
    update exceptions e
    set held = false, hold_released_at = now(),
        hold_release_reason = case when d.dedupe_key is null then 'cleared' else 'worse' end
    from exceptions e0
    join exception_rules r on r.type = e0.type and r.enabled and not (r.sources && v_stale)
    left join _detections d on d.dedupe_key = e0.dedupe_key
    where e.id = e0.id and e0.held
      and (
        d.dedupe_key is null
        or (d.severity = 'red' and e0.severity = 'amber')
        or (coalesce(e0.money_at_risk, 0) > 0 and d.money_at_risk > e0.money_at_risk * 1.25)
        or (e0.type = 'zero_spend' and e0.escalation = 0
            and now() - e0.first_detected_at >= interval '3 days'
            and e0.resolved_at - e0.first_detected_at < interval '3 days')
      )
    returning e.dedupe_key, e.escalation, e.hold_release_reason
  )
  select dedupe_key, max(escalation) + 1 as escalation from released where hold_release_reason = 'worse' group by dedupe_key;

  return query
  with u as (
    update exceptions e
    set last_detected_at = now(), reason = d.reason, money_at_risk = d.money_at_risk,
        severity = d.severity, owner_id = d.owner_id, owner_pod = d.owner_pod
    from _detections d
    where e.dedupe_key = d.dedupe_key and e.status in ('open', 'snoozed')
    returning e.id, e.type
  )
  select u.id, 'refreshed'::text, u.type from u;

  return query
  with i as (
    insert into exceptions (type, client_id, staff_id, owner_id, owner_pod, severity, reason,
                            money_at_risk, record_table, record_id, dedupe_key, escalation)
    select d.type, d.client_id, d.staff_id, d.owner_id, d.owner_pod, d.severity,
           d.reason || case when w.dedupe_key is not null then ' (worse since it was resolved)' else '' end,
           d.money_at_risk, d.record_table, d.record_id, d.dedupe_key, coalesce(w.escalation, 0)
    from _detections d
    left join _worse w on w.dedupe_key = d.dedupe_key
    where not exists (
      select 1 from exceptions e where e.dedupe_key = d.dedupe_key and (e.status in ('open', 'snoozed') or e.held))
    returning id, type
  )
  select i.id, 'opened'::text, i.type from i;

  return query
  with x as (
    update exceptions e
    set status = 'resolved', resolved_at = now(), resolved_by = 'system',
        resolution_note = 'Condition cleared'
    from exception_rules r
    where r.type = e.type and r.enabled and not (r.sources && v_stale)
      and e.status in ('open', 'snoozed')
      and not exists (select 1 from _detections d where d.dedupe_key = e.dedupe_key)
    returning e.id, e.type
  )
  select x.id, 'resolved'::text, x.type from x;
end $$;
revoke execute on function run_exceptions_engine() from public, anon, authenticated;
grant execute on function run_exceptions_engine() to service_role;
