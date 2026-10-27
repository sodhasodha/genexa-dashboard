-- The CSR confirmation desk (/confirmations), 27 Oct 2026.
--
-- Appointments on each clinic's Unconfirmed calendar, from 34 hours before the
-- appointment until 3 hours before it. CSRs call, log each attempt (up to 10),
-- and move confirmed patients to the clinic's main calendar in GHL themselves:
-- Genexa OS only reads GHL.
--
-- CSRs (Almarie, Marj) can use this desk and nothing else. In the database that
-- is done in one place: app_staff_id() and app_staff_pod() no longer recognise a
-- CSR as staff, so every existing staff policy and staff check refuses them, and
-- the desk's own tables let them in through app_csr_id().

create or replace function app_staff_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from staff where auth_user_id = auth.uid() and status <> 'left' and role <> 'csr' limit 1
$$;
create or replace function app_staff_pod() returns text
language sql stable security definer set search_path = public as $$
  select pod from staff where auth_user_id = auth.uid() and status <> 'left' and role <> 'csr' limit 1
$$;
create function app_csr_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from staff where auth_user_id = auth.uid() and status <> 'left' and role = 'csr' limit 1
$$;
grant execute on function app_csr_id() to authenticated, service_role;

-- Everyone can read their own staff row (a CSR needs her own name, nothing else).
create policy self_read on staff for select to authenticated using (auth_user_id = auth.uid());

-- Which calendars the desk reads: the Unconfirmed calendar of each clinic (and
-- location) and its main (Confirmed) calendar. Found by name on every sync.
create table clinic_calendars (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  calendar_id text not null,
  kind text not null check (kind in ('unconfirmed', 'main')),
  name text not null,
  location_label text,
  seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, calendar_id)
);
create trigger clinic_calendars_set_updated_at before update on clinic_calendars for each row execute function set_updated_at();
create trigger clinic_calendars_forbid_delete before delete on clinic_calendars for each row execute function forbid_delete();
alter table clinic_calendars enable row level security;
create policy owner_all on clinic_calendars for all to authenticated using (app_is_owner()) with check (app_is_owner());

-- One row per appointment that has been on an Unconfirmed calendar inside the window.
-- Full name and phone are kept here only: CSRs and the owner can read this table, nobody else.
create table confirmation_appointments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  ghl_appointment_id text not null,
  ghl_contact_id text,
  unconfirmed_calendar_id text not null,
  location_label text,
  patient_name text,
  phone text,
  scheduled_for timestamptz not null,
  clinic_timezone text not null,
  status text not null default 'unconfirmed'
    check (status in ('unconfirmed', 'confirmed', 'rescheduled', 'cancelled', 'unreachable', 'expired')),
  -- csr = logged on the desk; ghl = seen in GHL (moved to the main calendar, cancelled); system = expired
  status_source text check (status_source in ('csr', 'ghl', 'system')),
  status_at timestamptz,
  on_main_calendar boolean not null default false,
  ghl_status text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, ghl_appointment_id)
);
create index confirmation_appointments_time_idx on confirmation_appointments (scheduled_for);
create trigger confirmation_appointments_set_updated_at before update on confirmation_appointments for each row execute function set_updated_at();
create trigger confirmation_appointments_forbid_delete before delete on confirmation_appointments for each row execute function forbid_delete();
alter table confirmation_appointments enable row level security;
create policy owner_all on confirmation_appointments for all to authenticated using (app_is_owner()) with check (app_is_owner());
create policy csr_read on confirmation_appointments for select to authenticated using (app_csr_id() is not null);

create table confirmation_calls (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references confirmation_appointments(id),
  attempt_no integer not null check (attempt_no between 1 and 10),
  outcome text not null check (outcome in ('confirmed', 'no_answer', 'voicemail', 'rescheduled')),
  staff_id uuid not null references staff(id),
  called_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (appointment_id, attempt_no)
);
create index confirmation_calls_staff_idx on confirmation_calls (staff_id, called_at);
create trigger confirmation_calls_set_updated_at before update on confirmation_calls for each row execute function set_updated_at();
create trigger confirmation_calls_forbid_delete before delete on confirmation_calls for each row execute function forbid_delete();
create trigger confirmation_calls_audit after insert or update on confirmation_calls for each row execute function audit_row();
alter table confirmation_calls enable row level security;
create policy owner_all on confirmation_calls for all to authenticated using (app_is_owner()) with check (app_is_owner());
create policy csr_read on confirmation_calls for select to authenticated using (app_csr_id() is not null);
grant select on clinic_calendars, confirmation_appointments, confirmation_calls to authenticated, service_role;
grant insert, update on confirmation_appointments, confirmation_calls, clinic_calendars to service_role;

-- Logging a call is the only write a CSR makes, and only through this function:
-- the attempt number is the next one, at most 10, only while the appointment is
-- on the desk and still open, and the 10th unanswered attempt locks it to Unreachable.
create function confirmation_log_call(p_appointment uuid, p_outcome text) returns jsonb
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
  select count(*) into v_n from confirmation_calls where appointment_id = a.id;
  if v_n >= 10 then raise exception 'DESK_LIMIT: 10 attempts already' using errcode = 'P0001'; end if;
  select name into v_name from staff where id = v_staff;
  perform set_config('app.actor', v_name, true);
  insert into confirmation_calls (appointment_id, attempt_no, outcome, staff_id) values (a.id, v_n + 1, p_outcome, v_staff);
  update confirmation_appointments set
    status = case p_outcome when 'confirmed' then 'confirmed' when 'rescheduled' then 'rescheduled'
                  else case when v_n + 1 >= 10 then 'unreachable' else status end end,
    status_source = case when p_outcome in ('confirmed', 'rescheduled') or v_n + 1 >= 10 then 'csr' else status_source end,
    status_at = case when p_outcome in ('confirmed', 'rescheduled') or v_n + 1 >= 10 then now() else status_at end
  where id = a.id;
  return jsonb_build_object('attempt', v_n + 1, 'status', (select status from confirmation_appointments where id = a.id));
end $$;
revoke execute on function confirmation_log_call(uuid, text) from public, anon;
grant execute on function confirmation_log_call(uuid, text) to authenticated, service_role;

-- Still unconfirmed (or unreachable) at 3 hours: Expired - unconfirmed. Nothing is cancelled in GHL.
create function confirmations_expire(p_now timestamptz default now()) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update confirmation_appointments set status = 'expired', status_source = 'system', status_at = p_now
  where status in ('unconfirmed', 'unreachable') and scheduled_for <= p_now + interval '3 hours';
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function confirmations_expire(timestamptz) from public, anon, authenticated;
grant execute on function confirmations_expire(timestamptz) to service_role;

-- The desk: every appointment inside the window (34h to 3h before), with its calls.
-- It runs as its owner because CSRs cannot read clients or other staff (the clinic
-- name and who made the last call); instead it lets only the owner and CSRs in.
create view confirmation_desk as
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
  end as urgency
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
grant select on confirmation_desk to authenticated, service_role;

-- The call centre's numbers, per CSR, for a period (ET days): calls, outcomes,
-- confirmations, and how fast the first call came after the appointment reached the desk.
create function confirmation_stats(p_from date, p_to date)
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
    round(avg(extract(epoch from x.called_at - greatest(a.first_seen_at, a.scheduled_for - interval '34 hours')) / 60) filter (where x.attempt_no = 1))
  from staff s
  join confirmation_calls x on x.staff_id = s.id and app_day(x.called_at) between p_from and p_to
  join confirmation_appointments a on a.id = x.appointment_id
  -- Anyone on the team except a CSR (Aryan, and the media buyer who also runs the call centre).
  where app_is_privileged() or app_staff_id() is not null
  group by s.id, s.name
$$;
-- And for the whole desk: how many appointments reached it and how they ended.
create function confirmation_desk_totals(p_from date, p_to date)
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
$$;
grant execute on function confirmation_stats(date, date), confirmation_desk_totals(date, date) to authenticated, service_role;

-- No hard deletes anywhere: outcome_proposals (0062) was created without the guard.
create trigger outcome_proposals_forbid_delete before delete on outcome_proposals for each row execute function forbid_delete();
