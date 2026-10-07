# Genexa OS

The internal operating system for Genexa Scaling. It shows what is broken today and who owns it, and scores each team member on numbers recorded by systems, not typed in by people.

Live at https://ops.genexascaling.com. The plan, every table and every decision are in [PLAN.md](PLAN.md). Claude's access is documented in [MCP.md](MCP.md).

## Where each number comes from

| Number | Source |
|---|---|
| Ad spend, impressions, CTR, CPM, frequency, per-ad results | Cortana |
| Landing page views, leads, bookings, confirmations, shows, no-shows, closes, clinic revenue | Cortana (every source, test contacts left out) |
| Cash collected, memberships, renewals, client fees, MRR | Whop, direct |
| Expenses, profit, margin | Mercury, plus approved pay runs for team pay |
| Consult times (unlogged outcomes, consults tomorrow) | GHL calendars |
| Client and sales calls | Fathom |
| Attendance, pay | Clock in / out in the app, against the roster |
| Calls, speed to lead | Nothing yet. The call centre moves to Hot Prospector. |

A source that has not synced shows "no data". A source that has gone stale shows grey, and alerts that depend on it stop.

## Run it locally

```
cd genexa-os
npm install
cp .env.example .env.local      # then fill it in
npm run dev
```

`npm run check` runs typecheck, lint and the tests. The SQL tests run every migration on an in-process Postgres, so no database is needed for them.

## Environment variables

All are listed in `.env.example` with a comment each. They live in `.env.local` on a developer's machine and in the Vercel project `genexa-os`. Nothing with a key ever reaches the browser.

## Database

Migrations are `supabase/migrations/*.sql`, applied in order with `npm run db:push`. Never edit a migration that has been applied; add a new one. Nothing is ever hard-deleted, and every change to a business record is written to `audit_log`.

## Deploy

```
npx vercel@latest deploy --prod --yes     # from genexa-os/
```

The Vercel project is not connected to git, so pushing the repo does not deploy.

## Jobs

Jobs are HTTP calls to `/api/jobs/<name>` made by Supabase `pg_cron`. Set them up, or change the schedule, with:

```
npm run setup:cron -- https://ops.genexascaling.com
```

| Job | When | Does |
|---|---|---|
| `cortana-sync` | hourly | ad metrics for today and yesterday, per-ad 7-day and all-time figures |
| `cortana-events` | hourly | leads, bookings, shows, closes (re-reads 14 days) |
| `cortana-full` | 02:30 ET | re-reads the last 4 days of ad metrics |
| `whop-sync` | hourly | payments and memberships, customer-to-client matching |
| `mercury-sync` | 06:00 ET | bank transactions, then the finance rules |
| `ghl-appointments` | hourly | consult calendars, outcomes copied across from Cortana |
| `fathom-sync` | hourly | calls, touches, prospect call dates |
| `exceptions` | every 15 min | opens, refreshes and resolves exceptions |
| `attendance` | every 5 min | late / no-show status and alerts |
| `reminders` | every 5 min | every Slack reminder to the team |
| `router-process`, `router-replies` | every 5 min | client request router |
| `daily-snapshot` | 00:05 ET | stores the week's scores; freezes last month on the 1st |
| `pay-run` | Sunday 23:59 ET | builds the week's draft pay run and DMs the owner |
| `outcome-nudges` | Mondays, 10:00 clinic time | one short message in each clinic's General channel with the count of overdue outcomes and a link; nothing if there are none |

Jobs tied to a local time follow US and UK daylight saving on their own. Each run is logged; see Integrations in the app.

Manual runs from a developer's machine: `npm run sync:cortana -- --days 30`, `sync:whop`, `sync:mercury`, `sync:ghl`, `sync:fathom`, and `verify:cortana` (checks yesterday's spend against Cortana to the cent).

## Slack

Two workspaces, two installs of the same app.

- **Team workspace**: alerts, reminders, digests, and the Done / Snooze buttons.
- **Client workspace**: the app listens to client channels for requests. It posts there in only two cases: the Monday "outcomes waiting to be updated" message, and request-router thread replies when that setting is on.

## Add a clinic

1. Create it: the onboarding form posts to `/api/webhooks/onboarding`, or add it on the Clients page. It appears on the Launches board.
2. On the client's profile set the Cortana business id, billing cycle, fee per cycle and launch date. Without a Cortana id the clinic shows "not connected" and has no ad numbers.
3. If the clinic's Cortana business covers campaigns that are not ours, add a row to `client_campaign_scope` (a name the campaign must contain, or `verified = false` to leave the clinic out of every number until it is checked).
4. Add its GHL location id on the client record and its location key to `GHL_API_KEYS_JSON`, so its consult calendars sync.
5. Add its General and Scheduling Slack channel ids (client workspace) and invite the Genexa OS app to both channels.
6. Its Whop customer is matched automatically where the name or email is clear; otherwise pick the client once in Data review.
7. Work the launch on the Launches board. "Live" is refused until all six QC boxes are ticked.

## Sign in

Team members sign in with their email and a password. There is no self sign-up: a person must exist in `staff` with a login. The owner can put anyone's password back to their first name from the Team page ("Reset password").
