-- The desk row carries the GHL contact and location, so the app can open the
-- contact in GoHighLevel and read the patient's "Patient Information" field live
-- (that field is never stored here). Same view as 0067, two columns added at the end.
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
  c.ghl_location_id
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
