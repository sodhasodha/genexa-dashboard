-- Call centre totals count only appointments that were on the desk: ones GHL first
-- showed inside the last 3 hours (or after they started) never reached a CSR.
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
  where (app_is_privileged() or app_staff_id() is not null) and app_day(a.scheduled_for) between p_from and p_to
    and a.first_seen_at <= a.scheduled_for - interval '3 hours'
$$;
