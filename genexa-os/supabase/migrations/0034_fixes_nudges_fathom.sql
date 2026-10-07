-- 1. Attendance: a late clock-in turns a no-show into late on its own.
create or replace function attendance_status(p_start timestamptz, p_clock_in timestamptz, p_now timestamptz, p_old text) returns text
language sql stable set search_path = public as $$
  select case
    when p_start is null then p_old
    -- Clocked in: on time inside the grace window, otherwise late, however late.
    when p_clock_in is not null then
      case when extract(epoch from (p_clock_in - p_start)) > config_value('attendance_late_minutes') * 60 then 'late' else 'on_time' end
    -- Not clocked in yet.
    when extract(epoch from (p_now - p_start)) >= config_value('attendance_no_show_minutes') * 60 then 'no_show'
    when extract(epoch from (p_now - p_start)) > config_value('attendance_late_minutes') * 60 then 'late'
  end
$$;

-- ---------------------------------------------------------------------------
-- 2. Outcome nudges: the one message the app may post in a clinic's channel.
--    "N consults are waiting for an outcome", at most once every 7 days per clinic.
-- ---------------------------------------------------------------------------
insert into app_settings (key, value) values ('client_outcome_nudges', 'true') on conflict (key) do nothing;

-- Consults the clinic can still log: 24h to 21 days past, nothing recorded, and a
-- phone number on the booking (without one a logged outcome cannot be matched,
-- so the clinic would be chased for something it may have done).
create view outcome_nudges_due with (security_invoker = true) as
with waiting as (
  select a.client_id, a.contact_first_name, a.scheduled_for
  from appointments a
  where a.attendance = 'scheduled' and a.contact_key is not null
    and a.scheduled_for < now() - interval '24 hours' and a.scheduled_for > now() - interval '21 days'
)
select
  c.id as client_id, c.name,
  coalesce(c.slack_scheduling_id, c.slack_general_id) as channel,
  count(*) as waiting,
  string_agg(coalesce(w.contact_first_name, 'Patient') || ' (' || to_char(w.scheduled_for at time zone 'America/New_York', 'Dy DD Mon') || ')',
    ', ' order by w.scheduled_for) as consults,
  (select max(n.sent_at) from notifications n where n.rule_key = 'outcome_nudge' and n.record_id = c.id and n.slack_ts is not null) as last_nudged_at
from waiting w
join clients c on c.id = w.client_id
where c.deleted_at is null and c.stage = 'live'
group by c.id, c.name, c.slack_scheduling_id, c.slack_general_id;

-- The block on client channels stays for everything except this one rule.
create or replace function notifications_block_client_channels() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.rule_key <> 'outcome_nudge' and new.channel is not null and exists (
    select 1 from clients c where new.channel in (c.slack_general_id, c.slack_scheduling_id)
  ) then
    return null;
  end if;
  return new;
end $$;

insert into reminder_rules (key, enabled, audience, channel_or_dm, timing, template, urgent, quiet_hours_respected) values
  ('outcome_nudge', true, 'each clinic''s Scheduling channel (client workspace)', 'channel', 'Mondays 10:00 ET, at most once every 7 days per clinic', 'N consults are waiting for an outcome', false, false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Fathom calls. Names and email domains only; no email addresses are stored.
-- ---------------------------------------------------------------------------
create table fathom_calls (
  id uuid primary key default gen_random_uuid(),
  recording_id text not null unique,
  title text,
  started_at timestamptz not null,
  url text,
  share_url text,
  external_names text[] not null default '{}',
  external_domains text[] not null default '{}',
  kind text not null check (kind in ('client', 'prospect', 'internal', 'unmatched')),
  client_id uuid references clients(id),
  prospect_id uuid references prospects(id),
  match_reason text,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger fathom_calls_set_updated_at before update on fathom_calls for each row execute function set_updated_at();
create trigger fathom_calls_forbid_delete before delete on fathom_calls for each row execute function forbid_delete();
alter table fathom_calls enable row level security;
create policy owner_all on fathom_calls for all to authenticated using (app_is_owner()) with check (app_is_owner());
create policy staff_read on fathom_calls for select to authenticated using (app_staff_id() is not null);
