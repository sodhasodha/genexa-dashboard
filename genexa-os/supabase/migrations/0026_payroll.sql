-- Payroll: pay types, freelance jobs, the weekly pay run and the Overview feeds.
-- OWNER ONLY. Every table here has the owner_all policy and nothing else, and
-- every view is gated the same way, so staff read zero rows.
-- Depends on 0024 (attendance, shifts_resolved). Adds no columns to attendance.

-- ---------------------------------------------------------------------------
-- Pay types
-- ---------------------------------------------------------------------------
alter table staff_pay add column pay_type text check (pay_type in ('hourly', 'fixed_monthly', 'freelance'));
alter table staff_pay add column monthly_amount numeric(10,2) check (monthly_amount is null or monthly_amount >= 0);

-- A pay row for everyone whose pay type is known from their role or name.
insert into staff_pay (staff_id)
select s.id from staff s
where s.role in ('csr', 'freelance')
   or (s.role not in ('csr', 'freelance') and split_part(lower(btrim(s.name)), ' ', 1) in ('aditya', 'sameer'))
on conflict (staff_id) do nothing;

-- CSRs are hourly and keep the rate they already have.
update staff_pay sp set pay_type = 'hourly'
from staff s where s.id = sp.staff_id and s.role = 'csr';

update staff_pay sp set pay_type = 'freelance'
from staff s where s.id = sp.staff_id and s.role = 'freelance';

update staff_pay sp set pay_type = 'fixed_monthly', monthly_amount = 2000
from staff s where s.id = sp.staff_id and s.role not in ('csr', 'freelance')
  and split_part(lower(btrim(s.name)), ' ', 1) = 'aditya';

update staff_pay sp set pay_type = 'fixed_monthly', monthly_amount = 1000
from staff s where s.id = sp.staff_id and s.role not in ('csr', 'freelance')
  and split_part(lower(btrim(s.name)), ' ', 1) = 'sameer';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
-- One run per Mon–Sun ET week.
create table pay_runs (
  id uuid primary key default gen_random_uuid(),
  week_start date not null unique,
  week_end date not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'paid')),
  approved_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (extract(isodow from week_start) = 1),
  check (week_end = week_start + 6)
);

create table pay_run_lines (
  id uuid primary key default gen_random_uuid(),
  pay_run_id uuid not null references pay_runs(id),
  staff_id uuid not null references staff(id),
  pay_type text check (pay_type in ('hourly', 'fixed_monthly', 'freelance')),
  rostered_hours numeric(8,2) not null default 0,
  worked_hours numeric(8,2) not null default 0,
  late_count integer not null default 0,
  no_show_count integer not null default 0,
  -- Hourly rate, or the monthly amount for fixed pay. Null = not entered.
  rate numeric(10,2),
  -- Null = cannot be worked out (no rate or no pay type). Never a silent $0.
  gross numeric(12,2),
  adjustment numeric(12,2) not null default 0,
  adjustment_reason text,
  total numeric(12,2) generated always as (coalesce(gross, 0) + adjustment) stored,
  status text not null default 'draft' check (status in ('draft', 'approved', 'paid')),
  flags text[] not null default '{}',
  -- e.g. "not due this week" for fixed monthly pay outside the month-end run.
  note text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pay_run_id, staff_id),
  check (adjustment = 0 or btrim(coalesce(adjustment_reason, '')) <> ''),
  -- A line with no computable pay can never be approved or paid.
  check (status = 'draft' or gross is not null)
);
create index pay_run_lines_staff_idx on pay_run_lines (staff_id);

-- Per-job freelance pay. Picked up by the run for the week of `date`.
create table freelance_jobs (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id),
  date date not null,
  description text not null check (btrim(description) <> ''),
  amount numeric(12,2) not null check (amount > 0),
  pay_run_id uuid references pay_runs(id),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index freelance_jobs_staff_date_idx on freelance_jobs (staff_id, date);

do $$
declare t text;
begin
  foreach t in array array['pay_runs', 'pay_run_lines', 'freelance_jobs'] loop
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', t || '_set_updated_at', t);
    execute format('create trigger %I before delete on %I for each row execute function forbid_delete()', t || '_forbid_delete', t);
    execute format('create trigger %I after insert or update on %I for each row execute function audit_row()', t || '_audit', t);
    execute format('alter table %I enable row level security', t);
    execute format('create policy owner_all on %I for all to authenticated using (app_is_owner()) with check (app_is_owner())', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
-- One row per person per day they were rostered or have an attendance row, with
-- the minutes that count for pay.
--   Paid window = the rostered shift (attendance's own shift times, else the roster).
--   worked_minutes = clock-in → clock-out inside that window, or the full
--   clock-in → clock-out when overtime is approved. No clock-out = 0 minutes.
-- A shift belongs to the ET week of its start.
create view payroll_days with (security_invoker = true) as
with j as (
  select
    coalesce(a.staff_id, sr.staff_id) as staff_id,
    coalesce(a.date, sr.date) as date,
    a.id as attendance_id,
    coalesce(a.shift_start, sr.starts_at) as win_start,
    coalesce(a.shift_end, sr.ends_at) as win_end,
    a.clock_in, a.clock_out, a.status,
    coalesce(a.overtime_approved, false) as overtime_approved
  from attendance a
  full join (select staff_id, date, starts_at, ends_at from shifts_resolved where is_working) sr
    on sr.staff_id = a.staff_id and sr.date = a.date
  where app_is_privileged()
)
select
  j.staff_id, j.date, j.attendance_id,
  app_week_start(coalesce(app_day(coalesce(j.win_start, j.clock_in)), j.date)) as week_start,
  j.win_start as shift_start, j.win_end as shift_end,
  j.clock_in, j.clock_out, j.status, j.overtime_approved,
  case when j.status = 'excused' or j.win_start is null or j.win_end is null then 0
    else greatest(0, extract(epoch from (j.win_end - j.win_start)) / 60) end::numeric as rostered_minutes,
  case
    when j.clock_in is null or j.clock_out is null then 0
    when j.overtime_approved then extract(epoch from (j.clock_out - j.clock_in)) / 60
    when j.win_start is null or j.win_end is null then 0
    else greatest(0, extract(epoch from (least(j.clock_out, j.win_end) - greatest(j.clock_in, j.win_start))) / 60)
  end::numeric as worked_minutes,
  (j.clock_in is not null and j.clock_out is null) as no_clock_out,
  (j.clock_in is not null and (j.win_start is null or j.win_end is null) and not j.overtime_approved) as unrostered,
  (j.clock_in is not null and j.clock_out is not null and j.win_end is not null
    and j.clock_out > j.win_end and not j.overtime_approved) as overtime_unapproved
from j;

-- Who cannot be paid yet. Shown above the first run.
create view payroll_setup_gaps with (security_invoker = true) as
select s.id as staff_id, s.name, s.role, sp.pay_type,
  case when sp.pay_type is null then 'no pay type' else 'no rate' end as problem
from staff s
left join staff_pay sp on sp.staff_id = s.id
where app_is_privileged()
  and s.status <> 'left'
  and (s.role <> 'owner' or sp.pay_type is not null)
  and (sp.pay_type is null
    or (sp.pay_type = 'hourly' and sp.hourly_rate is null)
    or (sp.pay_type = 'fixed_monthly' and sp.monthly_amount is null));

-- A run with its totals. people = lines with money due.
create view pay_run_totals with (security_invoker = true) as
select r.id, r.week_start, r.week_end, r.status, r.approved_at, r.paid_at,
  coalesce(sum(l.total), 0) as total,
  count(l.id) filter (where l.total > 0) as people,
  count(l.id) as line_count,
  coalesce(sum(cardinality(l.flags)), 0)::int as flag_count,
  count(l.id) filter (where l.status = 'draft') as draft_lines,
  count(l.id) filter (where l.status = 'approved') as approved_lines,
  count(l.id) filter (where l.status = 'paid') as paid_lines
from pay_runs r
left join pay_run_lines l on l.pay_run_id = r.id
group by r.id;

-- ---------------------------------------------------------------------------
-- The weekly run
-- ---------------------------------------------------------------------------
-- Creates the run for the week if it is missing and (re)computes its DRAFT
-- lines. Approved and paid lines are never touched; adjustments are kept.
-- Runs as the caller: under RLS only the owner (or the service role) can build.
create function build_pay_run(p_week_start date) returns uuid
language plpgsql set search_path = public as $$
declare
  v_week date;
  v_run uuid;
  v_month_due boolean;
begin
  if p_week_start is null then
    raise exception 'PAY_RUN_WEEK: a week start is required' using errcode = 'P0001';
  end if;
  v_week := app_week_start(p_week_start);
  -- Fixed monthly pay falls due on the run whose week contains the last day of the month.
  v_month_due := (date_trunc('month', v_week) + interval '1 month' - interval '1 day')::date <= v_week + 6;

  insert into pay_runs (week_start, week_end) values (v_week, v_week + 6)
  on conflict (week_start) do nothing;
  select id into v_run from pay_runs where week_start = v_week;

  -- Freelance jobs: on this run when dated inside the week and not on a run yet.
  -- Jobs behind an approved or paid line are left alone.
  update freelance_jobs j set pay_run_id = null
  where j.pay_run_id = v_run
    and (j.deleted_at is not null or j.date not between v_week and v_week + 6)
    and not exists (select 1 from pay_run_lines l
      where l.pay_run_id = v_run and l.staff_id = j.staff_id and l.status <> 'draft');
  update freelance_jobs j set pay_run_id = v_run
  where j.pay_run_id is null and j.deleted_at is null
    and j.date between v_week and v_week + 6
    and not exists (select 1 from pay_run_lines l
      where l.pay_run_id = v_run and l.staff_id = j.staff_id and l.status <> 'draft');

  insert into pay_run_lines as t
    (pay_run_id, staff_id, pay_type, rostered_hours, worked_hours, late_count, no_show_count, rate, gross, flags, note)
  with d as (
    select pd.staff_id,
      sum(pd.rostered_minutes) as rostered_minutes,
      sum(pd.worked_minutes) as worked_minutes,
      count(*) filter (where pd.status = 'late') as late_count,
      count(*) filter (where pd.status = 'no_show') as no_show_count,
      count(*) filter (where pd.no_clock_out) as no_clock_out,
      count(*) filter (where pd.unrostered) as unrostered,
      count(*) filter (where pd.overtime_unapproved) as overtime_unapproved,
      count(*) filter (where pd.clock_in is not null) as clocked
    from payroll_days pd
    where pd.week_start = v_week
    group by pd.staff_id
  ),
  f as (
    select j.staff_id, sum(j.amount) as amount
    from freelance_jobs j
    where j.pay_run_id = v_run and j.deleted_at is null
    group by j.staff_id
  ),
  p as (
    select s.id as staff_id, sp.pay_type, sp.hourly_rate, sp.monthly_amount,
      -- Attendance decides the money only for hourly pay (and for people with no pay type yet).
      (sp.pay_type is null or sp.pay_type = 'hourly') as by_the_hour
    from staff s
    left join staff_pay sp on sp.staff_id = s.id
    where exists (select 1 from pay_run_lines l where l.pay_run_id = v_run and l.staff_id = s.id)
      or ((s.role <> 'owner' or sp.pay_type is not null)
        and ((s.status <> 'left' and (s.start_date is null or s.start_date <= v_week + 6))
          or exists (select 1 from d where d.staff_id = s.id and d.clocked > 0)
          or exists (select 1 from f where f.staff_id = s.id)))
  )
  select
    v_run, p.staff_id, p.pay_type,
    round(coalesce(d.rostered_minutes, 0) / 60.0, 2),
    round(coalesce(d.worked_minutes, 0) / 60.0, 2),
    coalesce(d.late_count, 0),
    coalesce(d.no_show_count, 0),
    case p.pay_type when 'hourly' then p.hourly_rate when 'fixed_monthly' then p.monthly_amount end,
    case p.pay_type
      when 'hourly' then round(coalesce(d.worked_minutes, 0) / 60.0 * p.hourly_rate, 2)
      when 'fixed_monthly' then case when p.monthly_amount is null then null when v_month_due then p.monthly_amount else 0 end
      when 'freelance' then coalesce(f.amount, 0)
    end,
    array_remove(array[
      case when p.pay_type is null then 'no pay type' end,
      case when (p.pay_type = 'hourly' and p.hourly_rate is null)
        or (p.pay_type = 'fixed_monthly' and p.monthly_amount is null) then 'no rate' end,
      case when p.by_the_hour and coalesce(d.no_clock_out, 0) > 0 then 'no clock-out' end,
      case when coalesce(d.no_show_count, 0) > 0 then 'no-show' end,
      case when p.by_the_hour and coalesce(d.unrostered, 0) > 0 then 'worked without a rostered shift' end,
      case when p.by_the_hour and coalesce(d.overtime_unapproved, 0) > 0 then 'overtime not approved' end
    ]::text[], null),
    case when p.pay_type = 'fixed_monthly' and p.monthly_amount is not null and not v_month_due then 'not due this week' end
  from p
  left join d on d.staff_id = p.staff_id
  left join f on f.staff_id = p.staff_id
  on conflict (pay_run_id, staff_id) do update set
    pay_type = excluded.pay_type,
    rostered_hours = excluded.rostered_hours,
    worked_hours = excluded.worked_hours,
    late_count = excluded.late_count,
    no_show_count = excluded.no_show_count,
    rate = excluded.rate,
    gross = excluded.gross,
    flags = excluded.flags,
    note = excluded.note
  where t.status = 'draft';

  return v_run;
end $$;

-- "Approve all": every draft line that can be paid (has a pay type and a rate),
-- then the run. Returns the number of lines approved.
create function approve_pay_run(p_run uuid) returns integer
language plpgsql set search_path = public as $$
declare n integer;
begin
  update pay_run_lines set status = 'approved'
  where pay_run_id = p_run and status = 'draft' and gross is not null
    and not (flags && array['no rate', 'no pay type']);
  get diagnostics n = row_count;
  update pay_runs set status = 'approved', approved_at = now() where id = p_run and status = 'draft';
  return n;
end $$;

-- "Mark paid": records the date on the run and on its approved lines. Draft
-- lines stay draft. Returns the number of lines marked paid.
create function mark_pay_run_paid(p_run uuid, p_paid_at timestamptz default now()) returns integer
language plpgsql set search_path = public as $$
declare n integer;
begin
  if exists (select 1 from pay_runs where id = p_run and status = 'draft') then
    raise exception 'PAY_RUN_NOT_APPROVED: approve the run before marking it paid' using errcode = 'P0001';
  end if;
  update pay_run_lines set status = 'paid', paid_at = p_paid_at
  where pay_run_id = p_run and status = 'approved';
  get diagnostics n = row_count;
  update pay_runs set status = 'paid', paid_at = coalesce(paid_at, p_paid_at) where id = p_run;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Feeds for the Overview (owner only: the tables underneath are owner only)
-- ---------------------------------------------------------------------------
-- Approved or paid lines on approved or paid runs whose week ends in the range.
-- Null when there are none.
create function payroll_cost(p_from date, p_to date) returns numeric
language sql stable set search_path = public as $$
  select sum(l.total)
  from pay_run_lines l
  join pay_runs r on r.id = l.pay_run_id
  where r.status in ('approved', 'paid') and l.status in ('approved', 'paid')
    and r.week_end between p_from and p_to
$$;

-- Payroll as a percentage (0–100) of classified, paid Whop cash in the range.
-- Null when either side is missing.
create function team_cost_pct(p_from date, p_to date) returns numeric
language sql stable set search_path = public as $$
  select case when c.cost is null or c.cash is null or c.cash = 0 then null
    else round(100 * c.cost / c.cash, 1) end
  from (
    select payroll_cost(p_from, p_to) as cost,
      (select sum(pay.amount) from payments pay
        where pay.classified and pay.status = 'paid' and app_day(pay.paid_at) between p_from and p_to) as cash
  ) c
$$;
