-- A churned clinic no longer owes outcomes (Terry L Franklin showed 7 from October).
-- Only the appointments fallback needs this: churned clinics are not on the client dashboard.
create or replace view outcomes_owed with (security_invoker = true) as
select p.id, p.client_id,
  case when p.stage = 'closed_won' then 'missing_revenue' else 'overdue' end as kind,
  p.first_name, p.consult_at, 'dashboard'::text as source, 'dashboard_patients'::text as record_table
from dashboard_patients p
join dashboard_connected d on d.client_id = p.client_id
where p.gone_at is null and (
  (p.stage = 'appointments_booked' and p.consult_at is not null and not p.appointment_cancelled and p.consult_at < now() - interval '24 hours')
  or (p.stage = 'closed_won' and p.revenue <= 0))
union all
select a.id, a.client_id, 'overdue', a.contact_first_name, a.scheduled_for, 'appointments', 'appointments'
from appointments a
left join leads l on l.id = a.lead_id
where a.attendance = 'scheduled' and coalesce(l.is_test, false) = false and a.scheduled_for < now() - interval '24 hours'
  and a.client_id not in (select d.client_id from dashboard_connected d)
  and not exists (select 1 from clients c where c.id = a.client_id and c.stage = 'churned');
