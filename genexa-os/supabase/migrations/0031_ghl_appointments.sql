-- GHL appointments, used only for the clinic-side outcome flow: consult times,
-- the unlogged-outcomes queue, the outcome chaser and "consults tomorrow".
-- Outcomes themselves still come from Cortana.

alter table appointments add column ghl_contact_id text;
alter table appointments add column contact_first_name text;
-- One-way hash of the patient's phone (or email): lets an appointment be matched
-- to a Cortana event for the same person without storing either.
alter table appointments add column contact_key text;
alter table appointments add column calendar_kind text check (calendar_kind in ('unconfirmed', 'confirmed'));
alter table appointments add column ghl_status text;
alter table appointments add column booked_at timestamptz;
alter table appointments add column synced_at timestamptz;
alter table appointments add constraint appointments_one_per_consult unique (client_id, ghl_contact_id, scheduled_for);
create index appointments_contact_key_idx on appointments (client_id, contact_key);

alter table cortana_events add column contact_key text;
create index cortana_events_contact_key_idx on cortana_events (client_id, contact_key);

update integration_sync_status set schedule_minutes = 60 where source = 'ghl';

-- GHL sub-accounts, matched to clients by hand from the names Ryan supplied.
update clients c set ghl_location_id = m.location_id
from (values
  ('multivita iv', 'LcEZublwtRYccyfiMdKW'),
  ('dr darren - pivotal health (lake worth)', 'NUrPwBnIrdvi2VAHAjGh'),
  ('dr russell smith knoxville', 'bcXCii8rGUc58H23JHs6'),
  ('regen rx', 'LoeLbAoGpZtOBQGZBaci'),
  ('regenestem', 'onIqS29X2dW8wiO717rP'),
  ('pure health medical', 'QuJmYp0koBEnRgjNo6IK'),
  ('vitale health clinic', 'k4wHWKm8HyFwnuFXhF17'),
  ('beyond stem cells', 'PoxnUvIXN2EawQyGr9ou'),
  ('terry l franklin md', 'GDD8HiUs0iaF9UVbq23H'),
  ('georgia interventional pain consultants', 'gqtVnJUL025PYxZ6XDLB'),
  ('reviv florida', 'yduRATchIt1LKN1AJnq7'),
  ('cleveland icp', 'gZkKnEVSrZfOkxwBMXet')
) as m(name, location_id)
where lower(c.name) = m.name and c.ghl_location_id is null;

-- Copy outcomes from Cortana onto appointments still waiting for one: the same
-- person at the same clinic, logged from 12h before the consult to 21 days after.
-- A show beats a no-show beats a cancellation when several were logged.
create function appointments_apply_outcomes() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with o as (
    select distinct on (a.id) a.id,
      case e.event when 'appointment_shown' then 'showed' when 'appointment_no_show' then 'no_show' else 'cancelled' end as attendance,
      e.occurred_at
    from appointments a
    join cortana_events e on e.client_id = a.client_id and e.contact_key = a.contact_key
      and e.event in ('appointment_shown', 'appointment_no_show', 'appointment_cancelled')
      and e.occurred_at between a.scheduled_for - interval '12 hours' and a.scheduled_for + interval '21 days'
    where a.attendance = 'scheduled' and a.contact_key is not null
    order by a.id, case e.event when 'appointment_shown' then 0 when 'appointment_no_show' then 1 else 2 end, e.occurred_at
  )
  update appointments a
  set attendance = o.attendance, attendance_logged_at = o.occurred_at, attendance_logged_by = 'clinic'
  from o where a.id = o.id;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function appointments_apply_outcomes() from public, anon, authenticated;
grant execute on function appointments_apply_outcomes() to service_role;

-- Consults booked for tomorrow (ET), per clinic.
create view consults_tomorrow with (security_invoker = true) as
select a.client_id, c.name,
  count(*) as consults,
  count(*) filter (where a.calendar_kind = 'confirmed') as confirmed
from appointments a join clients c on c.id = a.client_id
where app_day(a.scheduled_for) = app_today() + 1 and a.attendance = 'scheduled' and c.deleted_at is null
group by a.client_id, c.name;

create or replace view data_review_open with (security_invoker = true) as
with items as (
  select i.kind, i.record_table, i.record_id, i.client_id, i.title, i.detail, i.occurred_at
  from data_review_items i
  where not (i.kind = 'anomaly' and i.title like '%fee on record%')
    and i.kind <> 'unlogged_outcome'
  union all
  -- Consults 24h+ past with no outcome in Cortana (first name only).
  select 'unlogged_outcome', 'appointments', a.id, a.client_id,
    coalesce(a.contact_first_name, 'Patient') || ' · ' || c.name,
    'Consult ' || to_char(a.scheduled_for at time zone 'America/New_York', 'Dy DD Mon HH24:MI') || ' ET, no outcome logged',
    a.scheduled_for
  from appointments a join clients c on c.id = a.client_id
  where a.attendance = 'scheduled' and a.scheduled_for < now() - interval '24 hours'
    and a.scheduled_for > now() - interval '30 days'
  union all
  select 'anomaly', 'client_fees', f.client_id, f.client_id,
    f.name || ' · fee on record ' || coalesce('$' || f.record_monthly || '/month', 'missing') || ', Whop charges $' || f.whop_monthly || '/month',
    'Whop: ' || f.whop_plans || '. MRR uses the Whop figure until you confirm one.',
    now()
  from client_fees f where f.mismatch
  union all
  select 'unclassified_payment', 'payments', p.id, p.client_id,
    coalesce(c.name, p.customer_name, 'Unknown customer') || ' · $' || p.amount,
    'Paid ' || to_char(p.paid_at at time zone 'America/New_York', 'DD Mon') || ' with no Whop product. Not counted as cash collected until you say what it was.',
    p.paid_at
  from payments p left join clients c on c.id = p.client_id
  where p.status = 'paid' and not p.classified
)
select items.*, items.kind || ':' || items.record_id || ':' || md5(items.title) as item_key
from items
where not exists (
  select 1 from data_review_dismissals d
  where d.item_key = items.kind || ':' || items.record_id || ':' || md5(items.title));
