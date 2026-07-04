# Deploying to Vercel

The Genexa dashboard is a Next.js 14 app that persists data in **Vercel Postgres**
and pulls live data from Mercury, Whop, Fathom, Monday, Google, Slack, and the
Anthropic API. This guide takes you from a fresh clone to a running deployment.

> ⚠️ **No authentication is configured.** The dashboard exposes financial data
> (Mercury balance, transactions, revenue) to anyone who can reach the URL. Keep
> the deployment URL private, or add a gate (Vercel Deployment Protection, a
> password page, or Google login) before sharing it.

---

## 1. Push the repo

```bash
git remote add origin https://github.com/sodhasodha/genexa-dashboard.git
git push -u origin main
```

Then in Vercel: **Add New → Project → Import** this GitHub repo. Framework
auto-detects as Next.js; no build settings to change.

## 2. Provision Vercel Postgres

In the Vercel project: **Storage → Create Database → Postgres**. Connecting it to
the project automatically injects `POSTGRES_URL` (and related vars) into every
environment. No manual copying needed for the Postgres connection string.

To develop locally against it: `vercel env pull .env.development.local`.

## 3. Set environment variables

Add these under **Settings → Environment Variables** (copy the values from your
local `.env.local`). `POSTGRES_URL` is set for you by step 2.

| Variable | Used by |
|---|---|
| `MERCURY_API_KEY` | Finance Pulse (checking + credit card balance, transactions) |
| `FIXIE_URL` | Routes Mercury calls through a static IP (see step 6) |
| `WHOP_API_KEY` | Whop MTD revenue |
| `FATHOM_API_KEY` | Meeting Brief |
| `MONDAY_API_KEY` | Team pulse |
| `ANTHROPIC_API_KEY` | Daily Briefing + Slack task parsing (model `claude-sonnet-5`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | Calendar (+ Gmail/Drive clients) |
| `GOOGLE_CALENDAR_ID` | `primary` (or a specific calendar id) |
| `SLACK_BOT_TOKEN` / `SLACK_USER_ID` / `SLACK_CHANNEL_ID` | Slack → tasks sync |
| `CORTANA_API_KEY` | Reserved (no dashboard route yet) |
| `NEXT_PUBLIC_APP_NAME` | `Life OS` |

> **Rotate the keys** that were shared in plaintext during setup before this goes
> anywhere semi-public.

## 4. Deploy

Push to `main` (or click **Deploy**). Vercel builds and hosts the app.

## 5. Run the database migration (once)

Creates the tables and seeds the initial clients/relationships. It is idempotent —
safe to re-run; it never overwrites existing rows.

```bash
curl -X POST https://<your-app>.vercel.app/api/migrate
# or, with the app reachable at BASE_URL:
BASE_URL=https://<your-app>.vercel.app npm run db:migrate
```

Expected response: `{"ok":true,"created":true,"seededClients":10,"seededRelationships":2}`.

## 6. Confirm Mercury ↔ Fixie

Mercury production tokens are typically IP-allowlisted. All Mercury calls go out
through the Fixie proxy (`FIXIE_URL`) so they exit from a static IP.

- Make sure `FIXIE_URL` is set in Vercel (step 3).
- In Mercury's API settings, allowlist your **Fixie static IP**.
- If the balance/transaction cards read `$0`, this is the first thing to check.

---

## Post-deploy checklist

- [ ] `https://<app>/home` loads
- [ ] Finance Pulse shows real Mercury balances (Fixie IP allowlisted)
- [ ] `/api/migrate` returned `ok: true`
- [ ] Tasks/Goals persist across reloads (Postgres wired)
- [ ] Calendar card shows upcoming events
- [ ] Daily Briefing button streams a briefing
- [ ] (Optional) An auth gate is in place before sharing the URL

## Architecture notes

- **Persistence:** `@vercel/postgres`. Schema in `lib/db/schema.sql`, access layer
  in `lib/db.ts`, migration in `lib/db/migrate.ts` (run via `/api/migrate`).
  Tables: `tasks, goals, clients, relationships, docs, daily_logs, daily_habits`.
- **Client data layer:** `lib/storage.ts` — async functions that call `/api/data/*`.
- **Runtime:** all API routes are `force-dynamic` (per-request; never statically
  prerendered), so live data is never frozen at build time. They run on the Node
  runtime (required by `@vercel/postgres`, `googleapis`, and the Fixie proxy).
- **Device-local (still localStorage):** client tracker, lifetime-done counter,
  Slack processed timestamps, per-event calendar notes.
