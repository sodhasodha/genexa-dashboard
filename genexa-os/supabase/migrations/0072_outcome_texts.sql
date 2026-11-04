-- A clinic's manager is texted (SMS through the clinic's own GHL) for the outcome of each confirmed appointment,
-- and his replies are parsed and logged on the client dashboard. The dashboard writes GHL; Cortana reads GHL.
-- One texter per clinic contact; only appointments from live_from on are asked about, so switching one on never
-- texts a backlog.
create table if not exists outcome_texters (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  -- The manager's own contact in the clinic's GHL sub-account. Texts go to and are read from it.
  contact_id text not null,
  name text not null,
  live_from timestamptz not null default now(),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (client_id, contact_id)
);

-- One per patient appointment the manager is asked about.
--   asked          -> asked, waiting for a reply
--   reminded       -> no reply by the next morning, re-pinged once; after that the dashboard shows it overdue
--   logged         -> an outcome was logged from his reply
--   thinking       -> showed, thinking about it: logged as Showed - Not Sold, asked again 48h later
--   thinking_asked -> that 48h question was sent
--   done           -> nothing more to ask (closed later, said no, or the clinic logged it on the dashboard)
--   unsent         -> the question could not be texted; it is tried again on the next run
create table if not exists outcome_asks (
  id uuid primary key default gen_random_uuid(),
  texter_id uuid not null references outcome_texters(id),
  patient_contact_id text not null,
  patient_name text not null,
  appointment_at timestamptz not null,
  status text not null default 'asked' check (status in ('asked', 'reminded', 'logged', 'thinking', 'thinking_asked', 'done', 'unsent')),
  asked_at timestamptz not null default now(),
  reminded_at timestamptz,
  outcome text check (outcome in ('no_show', 'closed_won', 'not_closed')),
  amount numeric(12,2),
  logged_at timestamptz,
  follow_up_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  unique (texter_id, patient_contact_id, appointment_at)
);

create index if not exists outcome_asks_open on outcome_asks (texter_id, status);

-- Every text sent and every reply read. A reply's GHL message id is claimed here before it is acted on, so a reply
-- is handled once even if two runs overlap.
create table if not exists outcome_texts (
  id uuid primary key default gen_random_uuid(),
  texter_id uuid not null references outcome_texters(id),
  direction text not null check (direction in ('in', 'out')),
  ghl_message_id text unique,
  body text not null,
  at timestamptz not null default now(),
  parsed jsonb,
  error text
);

create index if not exists outcome_texts_texter on outcome_texts (texter_id, at desc);

create trigger outcome_texters_forbid_delete before delete on outcome_texters for each row execute function forbid_delete();
create trigger outcome_asks_forbid_delete before delete on outcome_asks for each row execute function forbid_delete();
create trigger outcome_texts_forbid_delete before delete on outcome_texts for each row execute function forbid_delete();

-- Service role only.
alter table outcome_texters enable row level security;
alter table outcome_asks enable row level security;
alter table outcome_texts enable row level security;
