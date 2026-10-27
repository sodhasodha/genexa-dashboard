-- The desk also shows appointments booked straight onto a clinic's Confirmed (main)
-- calendar, as Confirmed: nobody needs to call them, but the CSRs see the day.
-- booked_on says which calendar the appointment was first seen on; the calendar id
-- column now holds either kind.
alter table confirmation_appointments rename column unconfirmed_calendar_id to calendar_id;
alter table confirmation_appointments add column booked_on text not null default 'unconfirmed'
  check (booked_on in ('unconfirmed', 'main'));

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
  a.booked_on
from confirmation_appointments a
join clients c on c.id = a.client_id and c.deleted_at is null
left join lateral (
  select count(*)::int as attempts,
    (array_agg(x.called_at order by x.attempt_no desc))[1] as last_at,
    (array_agg(x.outcome order by x.attempt_no desc))[1] as last_outcome,
    (array_agg(s.name order by x.attempt_no desc))[1] as last_by
  from confirmation_calls x join staff s on s.id = x.staff_id
  where x.appointment_id = a.id
) k on true
where a.scheduled_for > now() + interval '3 hours'
  and a.scheduled_for <= now() + interval '34 hours'
  and (app_is_owner() or app_csr_id() is not null or current_user in ('service_role', 'postgres'));

-- Call centre totals stay about the CSRs' work: appointments booked as unconfirmed.
create or replace function confirmation_desk_totals(p_from date, p_to date)
returns table (appointments bigint, confirmed bigint, rescheduled bigint, cancelled bigint, unreachable bigint, expired bigint, open bigint, called bigint)
language sql stable security definer set search_path = public as $$
  select count(*),
    count(*) filter (where a.status = 'confirmed'),
    count(*) filter (where a.status = 'rescheduled'),
    count(*) filter (where a.status = 'cancelled'),
    count(*) filter (where a.status = 'unreachable'),
    count(*) filter (where a.status = 'expired'),
    count(*) filter (where a.status = 'unconfirmed'),
    count(*) filter (where exists (select 1 from confirmation_calls x where x.appointment_id = a.id))
  from confirmation_appointments a
  where (app_is_privileged() or app_staff_id() is not null)
    and a.booked_on = 'unconfirmed'
    and a.first_seen_at <= a.scheduled_for - interval '3 hours'
    and greatest(a.scheduled_for - interval '34 hours', a.first_seen_at) < ((p_to + 1)::timestamp at time zone 'America/New_York')
    and a.scheduled_for - interval '3 hours' > (p_from::timestamp at time zone 'America/New_York')
$$;
