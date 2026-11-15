-- A rescheduled appointment comes back to the desk as Unconfirmed (15 Nov 2026).
--
-- When a CSR logs "Rescheduled" and then moves the booking in GHL, GHL keeps the
-- same appointment id. The desk used to keep the old "Rescheduled" status and the
-- old calls on it, so the new booking (e.g. 5 Nov moved to 10 Nov) showed as
-- Rescheduled when it came round. Now:
--   1. Each appointment has a call cycle. A new time in GHL for a Rescheduled
--      appointment starts a new cycle: status Unconfirmed, attempts from 1 again.
--   2. rescheduled_from keeps the time the appointment had when "Rescheduled" was
--      logged, so the GHL sync can tell the booking has moved.
--   3. The desk shows and counts only the current cycle's calls. Earlier calls are
--      kept (call-centre numbers still count them); nothing is deleted.

alter table confirmation_appointments
  add column cycle integer not null default 1,
  add column rescheduled_from timestamptz;
alter table confirmation_calls add column cycle integer not null default 1;
alter table confirmation_calls drop constraint confirmation_calls_appointment_id_attempt_no_key;
alter table confirmation_calls add constraint confirmation_calls_cycle_attempt_key unique (appointment_id, cycle, attempt_no);

create or replace function confirmation_log_call(p_appointment uuid, p_outcome text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := coalesce(app_csr_id(), case when app_is_owner() then app_staff_id() end);
  a confirmation_appointments;
  v_n integer;
  v_name text;
begin
  if v_staff is null then raise exception 'DESK_REFUSED: only CSRs and the owner can log calls' using errcode = 'P0001'; end if;
  if p_outcome not in ('confirmed', 'no_answer', 'voicemail', 'rescheduled') then
    raise exception 'DESK_OUTCOME: unknown outcome' using errcode = 'P0001';
  end if;
  select * into a from confirmation_appointments where id = p_appointment for update;
  if not found then raise exception 'DESK_NOT_FOUND: no such appointment' using errcode = 'P0001'; end if;
  if a.status not in ('unconfirmed') then
    raise exception 'DESK_CLOSED: this appointment is % and takes no more calls', a.status using errcode = 'P0001';
  end if;
  if a.scheduled_for <= now() + interval '3 hours' then
    raise exception 'DESK_CLOSED: inside 3 hours of the appointment' using errcode = 'P0001';
  end if;
  select count(*) into v_n from confirmation_calls where appointment_id = a.id and cycle = a.cycle;
  if v_n >= 10 then raise exception 'DESK_LIMIT: 10 attempts already' using errcode = 'P0001'; end if;
  select name into v_name from staff where id = v_staff;
  perform set_config('app.actor', v_name, true);
  insert into confirmation_calls (appointment_id, cycle, attempt_no, outcome, staff_id) values (a.id, a.cycle, v_n + 1, p_outcome, v_staff);
  update confirmation_appointments set
    status = case p_outcome when 'confirmed' then 'confirmed' when 'rescheduled' then 'rescheduled'
                  else case when v_n + 1 >= 10 then 'unreachable' else status end end,
    status_source = case when p_outcome in ('confirmed', 'rescheduled') or v_n + 1 >= 10 then 'csr' else status_source end,
    status_at = case when p_outcome in ('confirmed', 'rescheduled') or v_n + 1 >= 10 then now() else status_at end,
    rescheduled_from = case when p_outcome = 'rescheduled' then a.scheduled_for else rescheduled_from end
  where id = a.id;
  return jsonb_build_object('attempt', v_n + 1, 'status', (select status from confirmation_appointments where id = a.id));
end $$;

create or replace function confirmation_edit_call(p_call uuid, p_outcome text) returns jsonb
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
  if x.cycle <> a.cycle then
    raise exception 'DESK_CLOSED: this call was for the booking before it was rescheduled' using errcode = 'P0001';
  end if;
  -- Once GHL or the 3-hour cut-off has decided the appointment, the calls are history.
  if a.status in ('cancelled', 'expired') or a.status_source in ('ghl', 'system') then
    raise exception 'DESK_CLOSED: this appointment is % and its calls can no longer be changed', a.status using errcode = 'P0001';
  end if;
  if a.scheduled_for <= now() + interval '3 hours' then
    raise exception 'DESK_CLOSED: inside 3 hours of the appointment' using errcode = 'P0001';
  end if;
  select max(attempt_no), count(*) into v_last, v_n from confirmation_calls where appointment_id = a.id and cycle = a.cycle;
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
  from confirmation_calls c where c.appointment_id = a.id and c.cycle = a.cycle and c.attempt_no = v_last;
  if v_status <> a.status then
    update confirmation_appointments
    set status = v_status,
        status_source = case when v_status = 'unconfirmed' then null else 'csr' end,
        status_at = case when v_status = 'unconfirmed' then null else now() end,
        rescheduled_from = case when v_status = 'rescheduled' then a.scheduled_for else rescheduled_from end
    where id = a.id;
  end if;
  return jsonb_build_object('attempt', x.attempt_no, 'status', v_status, 'was', x.outcome);
end $$;

-- Same view as 0071; the calls are the current cycle's only.
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
  where x.appointment_id = a.id and x.cycle = a.cycle
) k on true
where a.scheduled_for > now() + interval '3 hours'
  and a.scheduled_for <= now() + interval '34 hours'
  and (app_is_owner() or app_csr_id() is not null or current_user in ('service_role', 'postgres'));

-- Call-centre numbers: unchanged, except first-call speed is measured on the current
-- cycle only (an earlier cycle's first call belongs to the old time).
create or replace function confirmation_stats(p_from date, p_to date)
returns table (staff_id uuid, name text, calls bigint, appointments bigint, confirmed bigint, no_answer bigint, voicemail bigint, rescheduled bigint,
               unreachable bigint, first_call_minutes numeric)
language sql stable security definer set search_path = public as $$
  select s.id, s.name,
    count(x.*),
    count(distinct x.appointment_id),
    count(*) filter (where x.outcome = 'confirmed'),
    count(*) filter (where x.outcome = 'no_answer'),
    count(*) filter (where x.outcome = 'voicemail'),
    count(*) filter (where x.outcome = 'rescheduled'),
    count(*) filter (where x.attempt_no = 10 and x.outcome in ('no_answer', 'voicemail')),
    round(avg(extract(epoch from x.called_at - greatest(a.first_seen_at, a.scheduled_for - interval '34 hours')) / 60) filter (where x.attempt_no = 1 and x.cycle = a.cycle))
  from staff s
  join confirmation_calls x on x.staff_id = s.id and app_day(x.called_at) between p_from and p_to
  join confirmation_appointments a on a.id = x.appointment_id
  -- Anyone on the team except a CSR (Aryan, and the media buyer who also runs the call centre).
  where app_is_privileged() or app_staff_id() is not null
  group by s.id, s.name
$$;

-- Existing Rescheduled appointments.
-- Already moved to a later time (more than the desk's 34 hours after "Rescheduled" was
-- logged) and still to come: a new cycle now, Unconfirmed.
update confirmation_appointments
set status = 'unconfirmed', status_source = null, status_at = null, cycle = cycle + 1
where status = 'rescheduled' and scheduled_for > status_at + interval '34 hours' and scheduled_for > now();
-- The rest still have the time they had when "Rescheduled" was logged.
update confirmation_appointments set rescheduled_from = scheduled_for where status = 'rescheduled';
