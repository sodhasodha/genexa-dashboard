-- Genexa OS: tables.
-- Conventions: uuid PKs, created_at/updated_at everywhere, timestamptz in UTC.
-- Enumerations are text + check constraints so they can change in a plain migration.

create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------
create table staff (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,
  name text not null,
  email text unique,
  role text not null check (role in ('owner','media_buyer','tech','csr','freelance')),
  also_role text check (also_role in ('owner','media_buyer','tech','csr','freelance','call_centre_manager')),
  pod text check (pod in ('pod_1','pod_2','pod_3')),
  status text not null default 'active' check (status in ('trial','active','at_risk','left')),
  start_date date,
  slack_user_id text,
  legacy_ref text unique,
  shift_start time,
  shift_end time,
  timezone text not null default 'America/New_York',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Pay lives in its own table: RLS is row-level, and staff must not read pay.
create table staff_pay (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null unique references staff(id),
  hourly_rate numeric(10,2),
  hours_week numeric(6,2),
  weekly_pay numeric(10,2),
  payment_method text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Clients
-- ---------------------------------------------------------------------------
create table clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_name text,
  cortana_business_id text,
  ghl_location_id text,
  whop_customer_ids text[] not null default '{}',
  stage text not null default 'unlaunched' check (stage in ('unlaunched','onboarding','live','paused','churned')),
  pod text check (pod in ('pod_1','pod_2','pod_3')),
  owner_id uuid references staff(id),
  billing_cycle text check (billing_cycle in ('30','90','legacy')),
  -- 90-day deals are stored as fee / 3. MRR = sum(monthly_fee) over non-churned clients.
  monthly_fee numeric(12,2),
  launch_date date,
  guarantee_text text,
  guarantee_target_amount numeric(12,2),
  guarantee_deadline date,
  next_action text,
  last_contact_us timestamptz,
  last_reply_client timestamptz,
  slack_general_id text,
  slack_scheduling_id text,
  drive_url text,
  kickoff_url text,
  fathom_url text,
  closer_notes text,
  billing_notes text,
  contract_status text,
  ob_form_status text,
  ob_call_date date,
  onboarding_status text,
  churn_date date,
  churn_reason text,
  legacy_ref text,
  -- Imported once from monday.com for reference. Whop payments are the source of truth.
  legacy_last_payment_date date,
  legacy_total_paid numeric(12,2),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index clients_name_live_key on clients (lower(name)) where deleted_at is null;
create unique index clients_legacy_ref_key on clients (legacy_ref) where legacy_ref is not null;
create index clients_cortana_idx on clients (cortana_business_id);
create index clients_ghl_idx on clients (ghl_location_id);

create table client_locations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  name text not null,
  address text,
  doctors text[] not null default '{}',
  price_points text,
  calendar_url text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index client_locations_client_idx on client_locations (client_id);

-- Which Meta campaigns in a clinic's Cortana business are ours. Cortana reports a
-- whole business (and sometimes a whole ad account), so spend is only trusted
-- inside this scope. verified = false means the scope has not been checked by a
-- person: the clinic's ad numbers render as unverified and ad rules don't fire.
create table client_campaign_scope (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null unique references clients(id),
  -- Case-insensitive substring a campaign name must contain. Null = every campaign.
  campaign_name_contains text,
  ad_account_ids text[] not null default '{}',
  verified boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table launches (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  paid_at timestamptz,
  ob_call_booked_at timestamptz,
  ob_call_done_at timestamptz,
  ob_form_done_at timestamptz,
  access_done_at timestamptz,
  build_done_at timestamptz,
  qc_lead_access boolean not null default false,
  qc_calendar_tested boolean not null default false,
  qc_test_lead_deleted boolean not null default false,
  qc_pixel_firing boolean not null default false,
  qc_cortana_connected boolean not null default false,
  qc_clinic_sheet boolean not null default false,
  qc_passed_at timestamptz,
  live_at timestamptz,
  broke_week1 boolean not null default false,
  owner_id uuid references staff(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index launches_client_idx on launches (client_id);

-- ---------------------------------------------------------------------------
-- Tech work
-- ---------------------------------------------------------------------------
create table tech_jobs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id),
  type text not null check (type in ('launch','fix','build','other')),
  title text not null,
  notes text,
  requested_by uuid references staff(id),
  requested_at timestamptz not null default now(),
  -- launch = requested_at + 48h; fix = requested_at + 30 business minutes. Set by trigger.
  due_at timestamptz,
  started_at timestamptz,
  done_at timestamptz,
  status text not null default 'todo' check (status in ('todo','working','stuck','done')),
  blocked_on text,
  owner_id uuid references staff(id),
  broke_after_live boolean not null default false,
  legacy_ref text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tech_jobs_open_idx on tech_jobs (status, due_at) where deleted_at is null;
create unique index tech_jobs_legacy_ref_key on tech_jobs (legacy_ref) where legacy_ref is not null;

create table sla_pauses (
  id uuid primary key default gen_random_uuid(),
  tech_job_id uuid references tech_jobs(id),
  launch_id uuid references launches(id),
  paused_at timestamptz not null default now(),
  resumed_at timestamptz,
  reason text not null check (reason in ('client_access','client_approval','client_assets','third_party')),
  evidence_note text not null check (btrim(evidence_note) <> ''),
  paused_by uuid references staff(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((tech_job_id is not null) <> (launch_id is not null)),
  check (resumed_at is null or resumed_at >= paused_at)
);
-- One open pause per job / launch at a time.
create unique index sla_pauses_open_job_key on sla_pauses (tech_job_id) where resumed_at is null and tech_job_id is not null;
create unique index sla_pauses_open_launch_key on sla_pauses (launch_id) where resumed_at is null and launch_id is not null;

-- ---------------------------------------------------------------------------
-- Source tables. One source per table; sync jobs write here and nowhere else.
-- ---------------------------------------------------------------------------
-- Cortana
create table ad_metrics_daily (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  date date not null,
  spend numeric(12,2),
  impressions bigint,
  clicks bigint,
  ctr numeric,
  cpm numeric,
  frequency numeric,
  meta_leads integer,
  cortana_leads integer,
  cortana_booked integer,
  cortana_revenue numeric(12,2),
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, date)
);

create table ad_metrics_ad_daily (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  ad_id text not null,
  ad_name text,
  ad_status text,
  date date not null,
  spend numeric(12,2),
  impressions bigint,
  ctr numeric,
  frequency numeric,
  leads integer,
  booked integer,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, ad_id, date)
);

-- GHL
create table leads (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  ghl_contact_id text not null,
  name text,
  email text,
  -- created_at is GHL's contact creation time: speed to lead is measured from it.
  created_at timestamptz not null,
  first_call_at timestamptz,
  first_contact_at timestamptz,
  call_attempts integer not null default 0,
  booked_at timestamptz,
  appointment_at timestamptz,
  confirmed_at timestamptz,
  csr_id uuid references staff(id),
  is_test boolean not null default false,
  synced_at timestamptz not null default now(),
  inserted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, ghl_contact_id)
);
create index leads_client_created_idx on leads (client_id, created_at);
create index leads_csr_idx on leads (csr_id, created_at);

create table lead_calls (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id),
  client_id uuid not null references clients(id),
  ghl_message_id text not null,
  at timestamptz not null,
  direction text,
  status text,
  duration_seconds integer,
  staff_id uuid references staff(id),
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, ghl_message_id)
);
create index lead_calls_lead_idx on lead_calls (lead_id, at);

create table appointments (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id),
  client_id uuid not null references clients(id),
  ghl_appointment_id text,
  scheduled_for timestamptz not null,
  attendance text not null default 'scheduled'
    check (attendance in ('scheduled','cancelled','rescheduled_before_consult','no_show','showed','unknown')),
  attendance_logged_at timestamptz,
  attendance_logged_by text check (attendance_logged_by in ('clinic','genexa_csr')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index appointments_ghl_key on appointments (client_id, ghl_appointment_id) where ghl_appointment_id is not null;
create index appointments_client_sched_idx on appointments (client_id, scheduled_for);
create index appointments_lead_idx on appointments (lead_id);

-- Client dashboard webhook. Attendance and sale are separate records:
-- a patient can show, not close, follow up, and close 13 days later.
create table sales (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null unique references appointments(id),
  client_id uuid not null references clients(id),
  close_status text not null default 'open' check (close_status in ('open','follow_up','closed_won','closed_lost','refunded')),
  amount numeric(12,2),
  closed_at timestamptz,
  logged_at timestamptz,
  logged_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sales_client_closed_idx on sales (client_id, closed_at);

-- Whop (read through Cortana)
create table payments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id),
  whop_payment_id text not null unique,
  customer_name text,
  customer_email text,
  amount numeric(12,2) not null,
  paid_at timestamptz not null,
  product_title text,
  -- No product title = unclassified: excluded from revenue and shown as a data issue.
  classified boolean generated always as (product_title is not null and btrim(product_title) <> '') stored,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payments_client_paid_idx on payments (client_id, paid_at);

-- Mercury
create table finance_transactions (
  id uuid primary key default gen_random_uuid(),
  mercury_id text not null unique,
  posted_at timestamptz,
  amount numeric(14,2) not null,
  counterparty text,
  category text not null default 'unclassified'
    check (category in ('revenue','ads','software','payroll','excluded','unclassified')),
  included boolean not null default true,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table finance_rules (
  id uuid primary key default gen_random_uuid(),
  priority integer not null default 100,
  match_field text not null default 'counterparty' check (match_field in ('counterparty','description','kind')),
  pattern text not null,
  category text not null check (category in ('revenue','ads','software','payroll','excluded')),
  included boolean not null default true,
  note text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table integration_sync_status (
  source text primary key,
  schedule_minutes integer not null,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  status text not null default 'stale' check (status in ('ok','error','stale')),
  rows_processed integer,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table job_runs (
  id uuid primary key default gen_random_uuid(),
  job text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  rows_processed integer,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index job_runs_job_idx on job_runs (job, started_at desc);

create table webhook_events (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  event_id text not null,
  received_at timestamptz not null default now(),
  payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, event_id)
);

-- ---------------------------------------------------------------------------
-- Exceptions
-- ---------------------------------------------------------------------------
create table exceptions (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  client_id uuid references clients(id),
  staff_id uuid references staff(id),
  owner_id uuid references staff(id),
  owner_pod text check (owner_pod in ('pod_1','pod_2','pod_3')),
  severity text not null check (severity in ('red','amber')),
  reason text not null,
  money_at_risk numeric(12,2),
  record_table text,
  record_id uuid,
  first_detected_at timestamptz not null default now(),
  last_detected_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open','snoozed','resolved')),
  snoozed_until timestamptz,
  snooze_reason text,
  action_taken text,
  resolved_at timestamptz,
  resolved_by text,
  resolution_note text,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Unique while open: the same problem can reopen later as a new row.
create unique index exceptions_dedupe_open_key on exceptions (dedupe_key) where status in ('open','snoozed');
create index exceptions_owner_idx on exceptions (owner_id, status);
create index exceptions_client_idx on exceptions (client_id, status);

-- ---------------------------------------------------------------------------
-- Day-to-day records
-- ---------------------------------------------------------------------------
create table eods (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id),
  date date not null,
  role text not null,
  answers jsonb not null default '{}',
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (staff_id, date)
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references staff(id),
  parent_task_id uuid references tasks(id),
  title text not null,
  client_id uuid references clients(id),
  category text not null default 'general' check (category in ('ads','call_centre','tech','general')),
  priority text not null default 'medium' check (priority in ('high','medium','low')),
  due date,
  status text not null default 'todo' check (status in ('todo','doing','stuck','done')),
  task_group text not null default 'week' check (task_group in ('today','week','later','done')),
  source text not null default 'ryan' check (source in ('ryan','staff','pushpin','claude','call','slack','system')),
  notes text,
  done_at timestamptz,
  legacy_ref text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_owner_idx on tasks (owner_id, task_group) where deleted_at is null;
create unique index tasks_legacy_ref_key on tasks (legacy_ref) where legacy_ref is not null;

create table deleted_tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references staff(id),
  title text not null,
  deleted_at timestamptz not null default now(),
  legacy_ref text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index deleted_tasks_title_trgm on deleted_tasks using gin (title gin_trgm_ops);

create table prospects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text,
  state text,
  heat text check (heat in ('hot','warm','cold')),
  call_date date,
  what_they_want text,
  objection text,
  promised text,
  follow_up_date date,
  fathom_url text,
  deal_size numeric(12,2),
  stage text not null default 'chase' check (stage in ('chase','contract_out','paid','dead')),
  legacy_ref text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index prospects_legacy_ref_key on prospects (legacy_ref) where legacy_ref is not null;

create table ideas (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  source text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table touches (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  at timestamptz not null default now(),
  kind text not null check (kind in ('call','loom','report','slack','email')),
  by_id uuid references staff(id),
  note text,
  external_ref text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index touches_client_idx on touches (client_id, at desc);
create unique index touches_external_ref_key on touches (external_ref) where external_ref is not null;

create table agency_month (
  id uuid primary key default gen_random_uuid(),
  month date not null unique,
  snapshot jsonb not null,
  frozen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table briefs (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  kind text not null check (kind in ('daily','weekly')),
  body_markdown text not null,
  written_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (date, kind)
);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  row_id uuid,
  field text not null,
  old_value text,
  new_value text,
  actor text not null,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index audit_log_row_idx on audit_log (table_name, row_id, at desc);

-- ---------------------------------------------------------------------------
-- Configuration (editable by the owner without a deploy)
-- ---------------------------------------------------------------------------
create table scoring_config (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  card text not null,
  label text not null,
  -- higher_better: value >= green is green, >= amber is amber, else red.
  -- lower_better:  value <= green is green, <= amber is amber, else red.
  -- constant:      a plain number read from "value".
  direction text not null check (direction in ('higher_better','lower_better','constant')),
  green numeric,
  amber numeric,
  value numeric,
  unit text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app_settings (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  value jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table reminder_rules (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  enabled boolean not null default true,
  audience text not null,
  channel_or_dm text not null,
  timing text not null,
  template text not null,
  urgent boolean not null default false,
  quiet_hours_respected boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  rule_key text not null,
  staff_id uuid references staff(id),
  channel text,
  record_type text,
  record_id uuid,
  window_key text not null default '',
  held_until timestamptz,
  sent_at timestamptz,
  slack_ts text,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Never send the same rule for the same record to the same target twice in its window.
create unique index notifications_dedupe_key on notifications
  (rule_key, coalesce(staff_id::text, channel, ''), coalesce(record_id::text, ''), window_key);

create table person_scores_snapshot (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id),
  week_start date not null,
  card text not null,
  metric text not null,
  value numeric,
  numerator numeric,
  denominator numeric,
  colour text,
  is_baseline boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (staff_id, week_start, card, metric)
);
