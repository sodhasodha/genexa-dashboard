-- A GHL appointment keeps its id when it is moved to another time, so the id is
-- its identity. (Keying on patient + time made a rescheduled consult collide with itself.)
alter table appointments drop constraint appointments_one_per_consult;
drop index appointments_ghl_key;
alter table appointments add constraint appointments_ghl_unique unique (client_id, ghl_appointment_id);

-- When the confirmed copy of a consult replaces the unconfirmed one, it inherits
-- the reminders already sent, so the clinic is not told about the same patient twice.
create function appointments_carry_nudges() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update appointments b
  set nudge1_at = coalesce(b.nudge1_at, a.nudge1_at), nudge2_at = coalesce(b.nudge2_at, a.nudge2_at)
  from appointments a
  where a.client_id = b.client_id and a.ghl_contact_id = b.ghl_contact_id and a.id <> b.id
    and a.attendance = 'rescheduled_before_consult' and b.attendance = 'scheduled'
    and a.scheduled_for between b.scheduled_for - interval '36 hours' and b.scheduled_for + interval '36 hours'
    and (a.nudge1_at is not null and b.nudge1_at is null or a.nudge2_at is not null and b.nudge2_at is null);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function appointments_carry_nudges() from public, anon, authenticated;
grant execute on function appointments_carry_nudges() to service_role;
