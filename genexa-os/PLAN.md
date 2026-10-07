# Genexa OS — build plan

Standalone app in `genexa-os/` (separate Vercel project, root directory `genexa-os`). The Life OS dashboard at the repo root is untouched.

Stack: Next.js 16 (App Router, TypeScript, Cache Components on), Supabase (Postgres, Auth, RLS, pg_cron + pg_net), Tailwind 4, Vitest. SQL is tested against a real Postgres (PGlite, in-process) with a small Supabase shim, so views, triggers and RLS are proven before they touch the hosted database.

## 1. Folder structure

```
genexa-os/
  PLAN.md  README.md  MCP.md  .env.example
  proxy.ts                      # session refresh + redirect to /login (Next 16 name for middleware)
  app/
    login/                      # magic-link form, /auth/confirm callback
    (app)/                      # authenticated shell: sidebar + freshness
      page.tsx                  # role-based landing redirect
      overview/  clients/  clients/[id]/  launches/  call-centre/
      media-buying/  tech/  tasks/  pipeline/  ideas/
      eod/                      # one form per role, chosen from the logged-in user
      drill/[metric]/           # rows behind any number
    api/
      webhooks/outcome  webhooks/onboarding  webhooks/ghl  webhooks/slack (interactive)
      jobs/[job]                # called by pg_cron, bearer CRON_SECRET
      mcp                       # streamable HTTP MCP, bearer MCP_BEARER_TOKEN
  components/                   # display only: Table, Pill, Stat, Sidebar, FreshnessBar…
  lib/
    supabase/                   # server, browser, admin (service role) clients
    auth/                       # current staff, role guards, landing path
    integrations/<source>/      # client.ts (HTTP), mapper.ts (typed), sync.ts
    exceptions/                 # rule registry + engine
    reminders/                  # rule evaluation, quiet hours, Slack delivery
    sla/                        # business-hours maths (mirrors the SQL functions)
    queries/                    # typed reads of the SQL views, one file per page
    actions/                    # server actions (all writes)
    mcp/                        # tool definitions
  supabase/migrations/          # the schema — authoritative SQL
  fixtures/<source>/<endpoint>.json   # raw responses from real calls (monday/raw is git-ignored: pay + contacts)
  scripts/import-monday.ts  scripts/db-push.mjs
  tests/                        # sql/ (PGlite), unit/, fixtures-driven mapper tests
```

## 2. Schema

The SQL itself is `supabase/migrations/*.sql`; that is the single copy. Summary of what it contains:

**Conventions.** uuid PKs, `created_at` / `updated_at` on every table (trigger-maintained), timestamptz in UTC, ET for day/week/month boundaries (`app_today()`, `app_week_start()`). Enumerations are `text` + check constraints. Every view is `security_invoker`, so RLS applies through views.

**Tables from the spec** (columns as specified): `staff`, `clients`, `client_locations`, `launches`, `tech_jobs`, `sla_pauses`, `ad_metrics_daily`, `ad_metrics_ad_daily`, `leads`, `appointments`, `sales`, `payments`, `finance_transactions`, `integration_sync_status`, `exceptions`, `eods`, `tasks`, `deleted_tasks`, `prospects`, `ideas`, `touches`, `agency_month`, `briefs`, `audit_log`, `reminder_rules`, `notifications`, `scoring_config`, `finance_rules`.

**Deviations from the spec's column list, and why**

| Spec | Built | Reason |
|---|---|---|
| `clients.monthly_fee` stored (90-day = fee / 3) | `clients.cycle_fee` stored; `monthly_fee` generated from it | the renewal amount must be exactly the cycle fee ($5,000), not 3 × a rounded monthly figure. |
| `staff.hourly_rate, hours_week, weekly_pay, payment_method` | separate `staff_pay` table (1:1) | RLS is row-level. "Staff read everything except pay fields" needs the pay fields in their own owner-only table. |
| `tasks.group` | `tasks.task_group` | `group` is a reserved word. |
| `audit_log.by` | `audit_log.actor` | `by` is a reserved word. |
| `leads.created_at` | kept as the GHL creation time; row insert time is `inserted_at` | speed-to-lead needs GHL's timestamp, not ours. |
| `clients` | + `legacy_ref` | section 9. |
| — | `client_campaign_scope`, `clients.legacy_last_payment_date`, `clients.legacy_total_paid`, `legacy_ref` on imported tables | campaign scoping; values imported from Monday for reference; idempotent import. |
| `ad_metrics_ad_daily.ad_set_name` | dropped | Cortana has no ad-set level. |
| soft delete on 3 tables | `deleted_at` on every user-editable business table | rule 7: no hard deletes anywhere. A trigger rejects `DELETE` on every table. |
| `integration_sync_status` | + `schedule_minutes` | staleness = older than 2× schedule, so the schedule has to be stored. |
| — | `webhook_events(source, event_id unique)` | idempotency for inbound webhooks. |
| — | `lead_calls(lead_id, ghl_message_id, at, direction, status, duration, staff_id)` | call attempts need rows to drill into; `leads.call_attempts` / `first_call_at` are maintained from it. |
| — | `person_scores_snapshot`, `job_runs` | daily snapshot job output; job history. |

**Functions**
- `app_staff_id()`, `app_is_owner()`, `app_is_privileged()` — who is asking (security definer).
- `business_minutes_between(a, b)`, `add_business_minutes(ts, n)` — 09:00–17:00 ET, Mon–Fri.
- `tech_job_due_at(type, requested_at)` — launch +48h; fix +30 business minutes.
- `score_colour(key, value)` — green / amber / red from `scoring_config`.

**Triggers**
- `set_updated_at` on every table.
- `audit_row` on business tables: one `audit_log` row per changed field (insert logs one row).
- `forbid_delete` on every table.
- `tasks_rules`: only the owner adds to the owner's list (or source = pushpin); media buyer tasks must be ads / call_centre; automated creates refused on trigram similarity ≥ 0.6 against `deleted_tasks`; soft delete copies into `deleted_tasks`; non-owners may only change status fields on their own tasks.
- `tech_jobs_defaults`: sets `due_at` from type + `requested_at`.
- `leads_test_filter`: sets `is_test` on insert.
- `launches_stage_guard`: `live_at` refused unless all six QC flags are true.

**Exceptions engine (Phase 2).** `exception_rules` lists every rule with the sources it reads. `exception_detections` is a view with one row per thing wrong right now. `run_exceptions_engine()` opens, refreshes or auto-resolves by `dedupe_key`, and skips any rule with a stale source (opens nothing, resolves nothing). The API job only delivers the Slack DMs.

**Views (derived — sync jobs never write these)**
- `source_freshness` — per source: age, fresh / late / stale.
- `client_performance_daily` — per client per ET day: spend (Cortana), leads / booked / confirmed (GHL, non-test), shows / closes / revenue (outcome webhook), ratios.
- `client_monthly`, `client_mtd` — month roll-up: CPL, cost per booked, booking / confirmation / show / close rate, ROAS, rev share. `client_mtd` is the current month.
- `renewals` — last and next renewal, amount, status.
- `tech_job_sla`, `launch_sla` — Genexa time = elapsed − paused, overdue flag.
- `person_scores_weekly` — long format: staff, week, card, metric, value, numerator, denominator, colour, baseline. Built as a union of per-metric views; each scorecard phase (3, 4, 6) adds its metrics.
- `client_health` — one row per client per failing rule + rolled-up colour.
- `agency_month_live` — section 5.1 numbers, owner only.

**Definitions fixed here so every page agrees**
- Booking rate = booked ÷ leads. Confirmation rate = confirmed ÷ booked. All by the date the event happened.
- Show rate = showed ÷ (showed + no-show), by month of `scheduled_for`. Appointments with no outcome logged are counted separately as "outcomes pending" and never count as no-shows.
- Close rate = closed-won (month of `closed_at`) ÷ shows in that month.
- Renewal paid = a classified payment from 5 days before that renewal date up to 5 days before the following one. Overdue = the most recent renewal date has passed with no such payment.
- Next renewal amount = `cycle_fee`, the stored fee per billing cycle. `monthly_fee` = `cycle_fee` ÷ months in cycle; MRR sums it.

**RLS**
- Owner: read / write everything.
- Staff: read everything except `staff_pay`, `finance_transactions`, `finance_rules`, `agency_month`, `agency_month_live`, `audit_log`.
- Staff write: own `eods`; status of own `tasks`; `tech_jobs` they own, plus insert (request form); `sla_pauses` on jobs they own; `exceptions` they own (action taken, snooze, resolve); `launches` they own; `touches` they log; `notifications` acknowledgement.
- Sync jobs, webhooks and the MCP endpoint use the service role on the server only.

## 3. API routes and jobs

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/webhooks/outcome` | `WEBHOOK_SECRET` | upsert `appointments` + `sales`, idempotent on `event_id` |
| `POST /api/webhooks/onboarding` | `WEBHOOK_SECRET` | create `clients` (onboarding) + `launches` |
| `POST /api/webhooks/ghl` | `WEBHOOK_SECRET` | contact created, call, appointment created / updated |
| `POST /api/webhooks/slack` | Slack signing secret | Done / Snooze 1h buttons |
| `POST /api/jobs/[job]` | `CRON_SECRET` | every job below |
| `POST /api/mcp` | `MCP_BEARER_TOKEN` | section 8 tools |
| `GET /auth/confirm` | — | magic-link callback |

Jobs are scheduled in Supabase (`pg_cron` + `pg_net` → `/api/jobs/<name>`). Vercel Hobby only allows daily crons, so Vercel cron is not used.

| Job | Schedule (ET) | Writes |
|---|---|---|
| `cortana-sync` | hourly, all day (today + yesterday, per-ad 7d / all-time windows) | `ad_metrics_daily`, `ad_metrics_ad_daily`, `ad_metrics_ad_window` |
| `cortana-full` | 02:30 (re-reads the last 4 days) | same |
| `ghl-poll` | every 15 min | `leads`, `lead_calls`, `appointments` |
| `whop-sync` | hourly | `payments` |
| `mercury-sync` | daily 06:00 | `finance_transactions` |
| `fathom-sync` | hourly | `touches`, `clients.last_contact_us`, `prospects` |
| `exceptions` | every 15 min | `exceptions` |
| `outcome-chaser` | hourly | `appointments`, `tasks`, notifications |
| `reminders` | every 5 min | `notifications` + Slack |
| `weekly-client-report` | Mon 09:00 | emails |
| `daily-snapshot` | 00:05 | `person_scores_snapshot`, `agency_month` on the 1st |

Every job writes `integration_sync_status` (attempt, success, rows, error) and a `job_runs` row.

## 4. Environment

Section 2 of the brief, plus: `CRON_SECRET` (pg_cron → jobs), `APP_URL` (links in Slack messages), `CORTANA_BASE_URL`. An email sender for the weekly client report is needed in Phase 9.

## 5. Phases

- [x] **1 Foundation** — project, magic-link auth, roles + RLS, schema + views, audit triggers, Monday import, layout + sidebar, role landing. Done when every seed row loads, each role sees only what it should, typecheck / lint / tests pass.
- [x] **1b Team page** — staff list with each person's shift (start, end, timezone, working days) entered by the owner, and a coverage view: who is on, hour by hour in ET, with gaps flagged. Built before any reminder is sent, because every reminder is held to the recipient's shift.
- [x] **2 Cortana + exceptions engine** — fixtures, sync, sync status, ad + tech rules, Slack DM on open. Done when 12 clinics' spend for yesterday matches Cortana to the cent and a stale-source test proves rules don't fire.
- [x] **3 Tech page** — jobs, request form, SLA + pauses, tech EOD, scorecard. Done when tests cover Friday 16:50 → Monday 09:20, a pause is removed from Genexa time, and Rockwall shows overdue.
- [x] **4 Media Buying page** — account + ad tables over 3 windows, SOP stage, verdicts, fatigue, media EOD, scorecard.
- [x] **5 Overview v1** — freshness bar, bottlenecks, people cards, clients strip.
- [ ] **6 GHL + Call Centre** — blocked on a source for calls. Checked 7 Oct 2026: GHL conversations for Pivotal, Beyond and Multivita hold SMS, email and activity entries but no call records, and Cortana's calls endpoint is empty. GHL does hold appointments (consult time, status, and the user who moved a booking to the Confirmed calendar). — fixtures, webhooks + poll, test-lead filter, page, CSR EOD, leaderboard, live queue. Done when one real lead's speed to lead matches GHL by hand.
- [x] **7 Clients + Launches** (onboarding webhook not built) — list, lanes, profile, kanban + QC gate, onboarding webhook, locations editor.
- [ ] **8 Money + outcomes** — done: Whop direct sync, renewals from Whop, fees and MRR from Whop, Overview numbers. Not done: Mercury (no key), agency_month freeze, outcome chaser (needs appointment times). — Whop, renewals, guarantees, outcome webhook + chaser, Mercury + finance rules, agency_month, Overview numbers.
- [ ] **9 Tasks, Pipeline, Ideas + Slack reminders** — done: Tasks, Pipeline, Ideas pages, EOD forms, exception DMs held to shift. Not done: the reminder engine (section 7a), Slack Done / Snooze buttons, weekly client report. — task rules, reminder engine (7a), buttons, quiet hours, escalation, weekly report.
- [ ] **10 MCP endpoint** — tools, auth, rule enforcement, `MCP.md`, tests per tool.
- [ ] **11 Hardening** — drill-down everywhere, empty / stale / error states, mobile, 50-clinic load test, README.

## 6. Decisions made after the brief

- Legacy billing renews every 30 days (1 month for money at risk).
- Book-wide 7d cost per booked up 0–10% is green.
- Test-lead filter matches "test" as a whole word, ZZ prefixes, staff names / emails and test domains. A surname like "Testa" is a real lead.
- `ad_set_name` dropped: Cortana has no ad-set level (`groupBy` accepts source, campaign, medium, ad only).
- `client_campaign_scope` says which campaigns in a clinic's Cortana business are ours, and whether a person has verified that. Unverified scope = ad numbers shown as unverified and ad rules don't fire.
- No seed files. Starting data is a one-off, re-runnable import from monday.com (`npm run import:monday`, read-only on Monday). The team's logins are created by the same script.
- Slack: a separate Slack app for Genexa OS (not the Life OS bot).

## 7. Infrastructure

- Domain: `ops.genexascaling.com` (A record → 76.76.21.21 at Cloudflare, DNS only).
- Vercel project `genexa-os` (team ryan-7487s-projects), deployed from this folder with `npx vercel deploy --prod`. Not connected to git, so pushing the repo never deploys it by accident.
- Supabase `genexa-os-db` (free plan, us-east), provisioned through the Vercel Marketplace and connected to this project only. Migrations: `npm run db:push`.

## 7b. Sources (corrected 7 Oct 2026)

| Number | Source | Table |
|---|---|---|
| Spend, impressions, CTR, CPM, frequency, per-ad results | Cortana attribution (paid Meta rows in the clinic's scope) | `ad_metrics_daily`, `ad_metrics_ad_daily`, `ad_metrics_ad_window` |
| Landing page views, visitors, LP conversion rate | Cortana site tracking, all sources | `ad_metrics_daily.page_views`, `unique_visitors` |
| Leads, bookings, confirmations, shows, no-shows, cancellations, closes, revenue | Cortana conversion events, all sources, test contacts excluded | `cortana_events` |
| Cash collected, memberships, renewal dates, cancellations, unpaid invoices | Whop API, direct | `payments`, `whop_memberships` |
| Expenses, profit, margin | Mercury | `finance_transactions` |
| Client and sales calls | Fathom | `touches`, `prospects` |
| Call attempts, first-call time, who called | GHL (Cortana's calls endpoint returns no records for our clinics) | `leads`, `lead_calls` |

Two filters only: Regen RX spend counts campaigns named "Genexa"; Cleveland is left out of every number until its Cortana business is confirmed.
The outcome webhook from the client dashboard is no longer needed for numbers: Cortana already receives those outcomes.

## 8. Cortana facts (from real responses, 7 Sep – 6 Oct 2026)

- Event names: `lead`, `unconfirmed_appointment_booked` (= booked), `appointment_booked` (= confirmed), `appointment_shown`, `appointment_no_show`, `appointment_cancelled`, `purchase`.
- Per-row fields used: `spent`, `impressions`, `clicks`, `ctr`, `cpm`, `frequency`, `metaPlatformLeads`, `leads`, `conversions.<event>.uniqueCount`, `totalRevenue`, `effectiveStatus`, `customerId` (Meta ad account), `platformEntityId`.
- Ad rows carry no campaign id or name, and there is no endpoint that links them. A clinic limited to campaigns by name (Regen RX) therefore has account-level numbers but no ad-level rows, and no ad-level alerts.
- Cortana revises recent days (Pivotal 5 Oct moved from $67.61 to $68.23 within hours), which is why the nightly job re-reads 4 days.
- The sync runs hourly round the clock rather than 08–22, so the source is never "stale" overnight and rules keep running.
- Account frequency = impressions ÷ summed campaign reach (exact for one campaign). Per-ad frequency is Cortana's own figure.
- "Interventional Pain Consultants - Cleveland" reports spend from the same two ad accounts as the Georgia business and the base IPC business, so it is marked unverified.
