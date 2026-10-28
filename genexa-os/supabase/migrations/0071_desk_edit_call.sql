-- CSRs can correct the outcome of a call already logged (a wrong button pressed).
--   1. confirmation_edit_call changes one call's outcome, records who changed it and
--      when, and works out the appointment's status again from its calls.
--   2. The desk view lists every call on the appointment (calls), not only the last.
-- Nothing is deleted; the audit log keeps the old outcome.

alter table confirmation_calls
  add column edited_by uuid references staff(id),
  add column edited_at timestamptz;

create function confirmation_edit_call(p_call uuid, p_outcome text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := coalesce(app_csr_id(), case when app_is_owner() then app_staff_id() end);
  x confirmation_calls;
  a confirmation_appointments;
  v_last integer;
  v_n integer;
  v_status text;
begin
  if v_staff is null then raise exception 'DESK_REFUSED: only CSRs and the owner can edit calls' using errcode = 'P0001'; end if;
  if p_outcome not in ('confirmed', 'no_answer', 'voicemail', 'rescheduled') then
    raise exception 'DESK_OUTCOME: unknown outcome' using errcode = 'P0001';
  end if;
  select * into x from confirmation_calls where id = p_call;
  if not found then raise exception 'DESK_NOT_FOUND: no such call' using errcode = 'P0001'; end if;
  select * into a from confirmation_appointments where id = x.appointment_id for update;
  -- Once GHL or the 3-hour cut-off has decided the appointment, the calls are history.
  if a.status in ('cancelled', 'expired') or a.status_source in ('ghl', 'system') then
    raise exception 'DESK_CLOSED: this appointment is % and its calls can no longer be changed', a.status using errcode = 'P0001';
  end if;
  if a.scheduled_for <= now() + interval '3 hours' then
    raise exception 'DESK_CLOSED: inside 3 hours of the appointment' using errcode = 'P0001';
  end if;
  select max(attempt_no), count(*) into v_last, v_n from confirmation_calls where appointment_id = a.id;
  -- A call followed by another one was not answered with a decision.
  if p_outcome in ('confirmed', 'rescheduled') and x.attempt_no <> v_last then
    raise exception 'DESK_NOT_LAST: only the last call can be Confirmed or Rescheduled' using errcode = 'P0001';
  end if;
  if x.outcome = p_outcome then
    return jsonb_build_object('attempt', x.attempt_no, 'status', a.status, 'was', x.outcome);
  end if;

  perform set_config('app.actor', (select name from staff where id = v_staff), true);
  update confirmation_calls set outcome = p_outcome, edited_by = v_staff, edited_at = now() where id = x.id;

  -- The status again, from the calls: the last call's decision, else Unreachable at 10, else Unconfirmed.
  select case
      when c.outcome in ('confirmed', 'rescheduled') then c.outcome
      when v_n >= 10 then 'unreachable'
      else 'unconfirmed'
    end into v_status
  from confirmation_calls c where c.appointment_id = a.id and c.attempt_no = v_last;
  if v_status <> a.status then
    update confirmation_appointments
    set status = v_status,
        status_source = case when v_status = 'unconfirmed' then null else 'csr' end,
        status_at = case when v_status = 'unconfirmed' then null else now() end
    where id = a.id;
  end if;
  return jsonb_build_object('attempt', x.attempt_no, 'status', v_status, 'was', x.outcome);
end $$;
revoke execute on function confirmation_edit_call(uuid, text) from public, anon;
grant execute on function confirmation_edit_call(uuid, text) to authenticated, service_role;

-- Same view as 0070, with every call on the appointment at the end.
create or replace view confirmation_desk as
select
  a.id, a.client_id, c.name as clinic, a.location_label, a.patient_name, a.phone, a.scheduled_for, a.clinic_timezone,
  a.status, a.status_source, a.status_at, a.on_main_calendar, a.first_seen_at,
  round(extract(epoch from a.scheduled_for - now()) / 60)::int as minutes_left,
  coalesce(k.attempts, 0) as attempts,
  k.last_at, k.last_outcome, k.last_by,
  case
    when a.status = 'confirmed' then 'green'
    when a.status in ('cancelled', 'rescheduled') then 'grey'
    when a.scheduled_for - now() < interval '12 hours' then 'red'
    when a.scheduled_for - now() < interval '24 hours' then 'amber'
    else 'none'
  end as urgency,
  a.booked_on,
  a.ghl_contact_id,
  c.ghl_location_id,
  coalesce(k.calls, '[]'::jsonb) as calls
from confirmation_appointments a
join clients c on c.id = a.client_id and c.deleted_at is null
left join lateral (
  select count(*)::int as attempts,
    (array_agg(x.called_at order by x.attempt_no desc))[1] as last_at,
    (array_agg(x.outcome order by x.attempt_no desc))[1] as last_outcome,
    (array_agg(s.name order by x.attempt_no desc))[1] as last_by,
    jsonb_agg(jsonb_build_object('id', x.id, 'attempt', x.attempt_no, 'outcome', x.outcome, 'by', s.name,
      'at', x.called_at, 'edited_by', e.name, 'edited_at', x.edited_at) order by x.attempt_no) as calls
  from confirmation_calls x join staff s on s.id = x.staff_id
  left join staff e on e.id = x.edited_by
  where x.appointment_id = a.id
) k on true
where a.scheduled_for > now() + interval '3 hours'
  and a.scheduled_for <= now() + interval '34 hours'
  and (app_is_owner() or app_csr_id() is not null or current_user in ('service_role', 'postgres'));
