-- Life OS Dashboard — Postgres schema
-- Column types mirror the TypeScript interfaces in lib/types.ts.
-- Numeric/bigint columns come back from the pg driver as strings; lib/db.ts
-- coerces them with Number() so the app-facing shapes stay identical.

CREATE TABLE IF NOT EXISTS tasks (
  id        TEXT PRIMARY KEY,
  name      TEXT    NOT NULL DEFAULT '',
  col       TEXT    NOT NULL DEFAULT 'backlog',   -- backlog | week | today | waiting | done
  priority  TEXT    NOT NULL DEFAULT 'normal',    -- normal | warm | hot
  starred   BOOLEAN NOT NULL DEFAULT false,
  due_date  TEXT,
  notes     TEXT    NOT NULL DEFAULT '',
  created   BIGINT  NOT NULL DEFAULT 0,
  done_at   BIGINT
);

CREATE TABLE IF NOT EXISTS goals (
  id      TEXT PRIMARY KEY,
  name    TEXT    NOT NULL DEFAULT '',
  current NUMERIC NOT NULL DEFAULT 0,
  target  NUMERIC NOT NULL DEFAULT 0,
  notes   TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS clients (
  id                TEXT PRIMARY KEY,
  name              TEXT    NOT NULL DEFAULT '',
  company           TEXT,
  vertical          TEXT    NOT NULL DEFAULT 'Genexa',
  payment_type      TEXT    NOT NULL DEFAULT 'Recurring',
  amount            NUMERIC,                        -- nullable (some clients have no set amount)
  term_days         INTEGER,
  outstanding       NUMERIC NOT NULL DEFAULT 0,
  next_payment_due  TEXT,
  next_contact      TEXT,
  churn_risk        TEXT    NOT NULL DEFAULT 'Low',
  ad_status         TEXT    NOT NULL DEFAULT 'Active',
  ad_health         TEXT,
  next_action       TEXT    NOT NULL DEFAULT '',
  notes             TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS relationships (
  id             TEXT PRIMARY KEY,
  name           TEXT    NOT NULL DEFAULT '',
  role           TEXT    NOT NULL DEFAULT '',
  channel        TEXT    NOT NULL DEFAULT '',
  why_contact    TEXT    NOT NULL DEFAULT '',
  freq_days      INTEGER NOT NULL DEFAULT 0,
  last_contacted TEXT    NOT NULL DEFAULT '',
  notes          TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS docs (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  url  TEXT NOT NULL DEFAULT '',
  tag  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS daily_logs (
  date            TEXT PRIMARY KEY,
  sleep           NUMERIC,
  feeling         NUMERIC,
  exercise_hours  NUMERIC,
  calories_burned NUMERIC,
  steps_taken     NUMERIC,
  calories_eaten  NUMERIC,
  energy          NUMERIC,
  wins_today      TEXT,
  challenges      TEXT,
  tomorrows_focus TEXT
);

CREATE TABLE IF NOT EXISTS daily_habits (
  date        TEXT PRIMARY KEY,
  gym         BOOLEAN NOT NULL DEFAULT false,
  eat_healthy BOOLEAN NOT NULL DEFAULT false,
  deep_work   BOOLEAN NOT NULL DEFAULT false,
  eod_done    BOOLEAN NOT NULL DEFAULT false
);
