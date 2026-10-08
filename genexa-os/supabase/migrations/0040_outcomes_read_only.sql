-- Outcomes are logged in one place only: the client dashboard. Genexa OS reads
-- them from Cortana and never writes one. The default link for the Monday
-- message and for the owner's Unlogged outcomes queue is the dashboard itself;
-- a clinic's own page can be set on clients.outcome_link.
insert into app_settings (key, value) values ('client_outcome_link', '"https://client.genexascaling.com"')
on conflict (key) do nothing;

-- Staff and the owner can no longer set attendance by hand: only the system
-- (the GHL sync and the Cortana outcome copy, both service role) writes it.
create function appointments_outcomes_read_only() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null and (new.attendance is distinct from old.attendance
      or new.attendance_logged_at is distinct from old.attendance_logged_at
      or new.attendance_logged_by is distinct from old.attendance_logged_by) then
    raise exception 'OUTCOMES_READ_ONLY: outcomes are logged on the client dashboard, not in Genexa OS';
  end if;
  return new;
end $$;
create trigger appointments_outcomes_read_only before update on appointments
  for each row execute function appointments_outcomes_read_only();

create function sales_read_only() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null then
    raise exception 'OUTCOMES_READ_ONLY: sales are logged on the client dashboard, not in Genexa OS';
  end if;
  return new;
end $$;
create trigger sales_read_only before insert or update on sales
  for each row execute function sales_read_only();
