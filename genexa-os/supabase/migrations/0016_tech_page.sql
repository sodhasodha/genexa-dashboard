-- Phase 3: Tech page. Board view, weekly tech scorecard, resuming a pause, and
-- closing an open pause when a job is marked done. No new tables.

-- ---------------------------------------------------------------------------
-- A job marked done cannot stay paused: close its open pause at the done time.
-- (tech_job_sla already caps pause time at done_at, so no number changes.)
-- ---------------------------------------------------------------------------
create function tech_jobs_close_pause() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update sla_pauses
    set resumed_at = greatest(paused_at, coalesce(new.done_at, now()))
    where tech_job_id = new.id and resumed_at is null;
  return new;
end $$;

create trigger tech_jobs_close_pause after update of status on tech_jobs
  for each row when (new.status = 'done' and old.status is distinct from 'done')
  execute function tech_jobs_close_pause();

-- Resume: close the job's open pause on the database clock. Runs as the caller,
-- so RLS decides whether they may (the job's owner, or the app owner).
create function resume_tech_job(p_job_id uuid) returns integer
language plpgsql as $$
declare v_count integer;
begin
  update sla_pauses set resumed_at = greatest(paused_at, now())
    where tech_job_id = p_job_id and resumed_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- One row per tech job with everything the Tech page shows.
-- ---------------------------------------------------------------------------
create view tech_jobs_board with (security_invoker = true) as
select
  j.id as tech_job_id,
  j.type,
  j.title,
  j.notes,
  j.client_id,
  c.name as client_name,
  j.requested_by,
  rb.name as requested_by_name,
  j.owner_id,
  ow.name as owner_name,
  j.requested_at,
  j.due_at,
  j.done_at,
  j.status,
  j.blocked_on,
  j.broke_after_live,
  s.sla_minutes,
  s.genexa_minutes,
  s.paused_minutes,
  s.pause_count,
  s.is_paused,
  s.is_overdue,
  s.met_sla,
  p.id as open_pause_id,
  p.reason as pause_reason,
  p.evidence_note as pause_evidence,
  p.paused_at,
  (j.done_at is not null
    and app_week_start(app_day(j.done_at)) = app_week_start(app_today())) as done_this_week
from tech_jobs j
join tech_job_sla s on s.tech_job_id = j.id
left join clients c on c.id = j.client_id
left join staff rb on rb.id = j.requested_by
left join staff ow on ow.id = j.owner_id
left join sla_pauses p on p.tech_job_id = j.id and p.resumed_at is null
where j.deleted_at is null;

-- ---------------------------------------------------------------------------
-- Tech scorecard, per tech person per ET week (Mon-Sun), 12 weeks back.
-- A job belongs to the week it was completed in (done_at, ET) and to its owner.
--   launch_sla_pct  % of launch jobs completed in the week that met SLA
--   fix_sla_pct     % of fix jobs completed in the week that met SLA
--   broken_week1    launches that went live in the week and were flagged broken:
--                   launches.broke_week1 (by live_at) plus tech_jobs.broke_after_live
--                   (by done_at). A launch row and a tech job for the same clinic in
--                   the same week count once. Denominator = launches live in the week.
--   paused_pct      % of jobs completed in the week that were paused at least once
--                   (shown, not scored)
-- A metric with nothing to measure has value null and colour null.
-- ---------------------------------------------------------------------------
create view score_tech_weekly with (security_invoker = true) as
with weeks as (
  select g::date as week_start
  from generate_series(
    app_week_start(app_today()) - 84, app_week_start(app_today()), interval '7 day') g
),
people as (
  select s.id as staff_id
  from staff s
  where s.role = 'tech' and s.status <> 'left'
),
done_jobs as (
  select
    j.id, j.owner_id, j.client_id, j.type, j.broke_after_live,
    app_week_start(app_day(j.done_at)) as week_start,
    s.met_sla, s.pause_count
  from tech_jobs j
  join tech_job_sla s on s.tech_job_id = j.id
  where j.done_at is not null and j.deleted_at is null
),
job_agg as (
  select
    p.staff_id, w.week_start,
    count(d.id) filter (where d.type = 'launch') as launch_done,
    count(d.id) filter (where d.type = 'launch' and d.met_sla) as launch_met,
    count(d.id) filter (where d.type = 'fix') as fix_done,
    count(d.id) filter (where d.type = 'fix' and d.met_sla) as fix_met,
    count(d.id) as jobs_done,
    count(d.id) filter (where d.pause_count > 0) as jobs_paused
  from people p
  cross join weeks w
  left join done_jobs d on d.owner_id = p.staff_id and d.week_start = w.week_start
  group by 1, 2
),
live_events as (
  -- The launches table carries no tech owner, so every launch counts for the tech person.
  select p.staff_id, app_week_start(app_day(l.live_at)) as week_start,
    l.client_id::text as launch_key, l.broke_week1 as broke
  from people p
  cross join launches l
  where l.live_at is not null
  union all
  select d.owner_id, d.week_start, coalesce(d.client_id::text, d.id::text), d.broke_after_live
  from done_jobs d
  where d.type = 'launch' or d.broke_after_live
),
live_one as (
  select staff_id, week_start, launch_key, bool_or(broke) as broke
  from live_events
  group by 1, 2, 3
),
live_agg as (
  select staff_id, week_start,
    count(*) as launches_live,
    count(*) filter (where broke) as launches_broken
  from live_one
  group by 1, 2
)
select
  a.staff_id,
  a.week_start,
  'tech'::text as card,
  m.metric,
  m.value,
  m.numerator,
  m.denominator,
  case when m.config_key is null then null else score_colour(m.config_key, m.value) end as colour
from job_agg a
left join live_agg l on l.staff_id = a.staff_id and l.week_start = a.week_start
cross join lateral (values
  ('launch_sla_pct'::text, 'tech_launch_sla_pct'::text,
    case when a.launch_done > 0 then round(100.0 * a.launch_met / a.launch_done, 1) end,
    a.launch_met::numeric, a.launch_done::numeric),
  ('fix_sla_pct', 'tech_fix_sla_pct',
    case when a.fix_done > 0 then round(100.0 * a.fix_met / a.fix_done, 1) end,
    a.fix_met::numeric, a.fix_done::numeric),
  ('broken_week1', 'tech_broken_week1',
    case when coalesce(l.launches_live, 0) > 0 then l.launches_broken::numeric end,
    coalesce(l.launches_broken, 0)::numeric, coalesce(l.launches_live, 0)::numeric),
  ('paused_pct', null,
    case when a.jobs_done > 0 then round(100.0 * a.jobs_paused / a.jobs_done, 1) end,
    a.jobs_paused::numeric, a.jobs_done::numeric)
) as m(metric, config_key, value, numerator, denominator);

grant select on tech_jobs_board, score_tech_weekly to authenticated, service_role;
