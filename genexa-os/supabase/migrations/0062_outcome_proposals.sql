-- Patient outcomes a clinic mentions in Slack ("Maria no showed", "Jane closed for $6k") without logging them on the
-- client dashboard. Each is DM'd to the owner with a Confirm button; on confirm Genexa OS logs it on the client
-- dashboard on the clinic's behalf. Nothing is logged without that click.
create table if not exists outcome_proposals (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references client_requests(id),
  client_id uuid not null references clients(id),
  -- The patient as the message names them (first name, maybe a surname or initial).
  patient_first text not null,
  patient_last text,
  outcome text not null check (outcome in ('no_show', 'closed_won', 'not_closed')),
  amount numeric(12,2),
  -- Patients on the client dashboard the name could mean: [{contact_id, name, stage, appointment}].
  candidates jsonb not null default '[]'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'logging', 'logged', 'ignored', 'failed')),
  contact_id text,
  decided_by text,
  decided_at timestamptz,
  error text,
  dm_channel text,
  dm_ts text,
  created_at timestamptz not null default now(),
  unique (request_id, patient_first, outcome)
);

create index if not exists outcome_proposals_status on outcome_proposals (status, created_at desc);

-- Service role only.
alter table outcome_proposals enable row level security;
