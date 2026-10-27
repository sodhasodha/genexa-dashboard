-- Call centre totals: the appointments that were on the desk at some point in the
-- period (34h to 3h before each one, ET days), not the ones scheduled in it, so
-- "Today" counts what the CSRs worked today (mostly tomorrow's appointments).
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
    and a.first_seen_at <= a.scheduled_for - interval '3 hours'
    and greatest(a.scheduled_for - interval '34 hours', a.first_seen_at) < ((p_to + 1)::timestamp at time zone 'America/New_York')
    and a.scheduled_for - interval '3 hours' > (p_from::timestamp at time zone 'America/New_York')
$$;
