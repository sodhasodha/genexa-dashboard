// Schedules the app's jobs in Supabase (pg_cron + pg_net). Re-runnable.
//   npm run setup:cron
// pg_cron calls POST {APP_URL}/api/jobs/<job> with "Authorization: Bearer CRON_SECRET".
// The secret lives in Supabase Vault, never in a migration or in git.
import pg from "pg";

const need = (name) => {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name} in .env.local`);
    process.exit(1);
  }
  return v;
};
const appUrl = (process.argv[2] ?? need("CRON_TARGET_URL")).replace(/\/$/, "");
const secret = need("CRON_SECRET");

// Interval jobs run on plain UTC cron. Jobs that belong to a local time are
// scheduled at BOTH UTC hours that local hour can fall on (summer / winter), and
// the app runs only the one where it really is that hour locally, so they follow
// UK and US daylight saving without anyone changing a schedule.
// name, cron (UTC), job, timeout ms
const INTERVAL = [
  ["genexa-cortana-sync", "5 * * * *", "cortana-sync", 290000],
  ["genexa-cortana-events", "35 * * * *", "cortana-events", 290000],
  ["genexa-whop-sync", "20 * * * *", "whop-sync", 120000],
  ["genexa-ghl-appointments", "50 * * * *", "ghl-appointments", 290000],
  ["genexa-ghl-forms", "40 * * * *", "ghl-forms", 120000],
  ["genexa-fathom-sync", "45 * * * *", "fathom-sync", 120000],
  ["genexa-attendance", "*/5 * * * *", "attendance", 60000],
  ["genexa-reminders", "2-59/5 * * * *", "reminders", 120000],
  ["genexa-exceptions", "*/15 * * * *", "exceptions", 60000],
  ["genexa-outcome-nudges", "0 * * * 1", "outcome-nudges", 120000], // Mondays only, hourly; each clinic is messaged at 10:00 its own time
  ["genexa-router-process", "1-59/5 * * * *", "router-process", 120000],
  ["genexa-router-replies", "3-59/5 * * * *", "router-replies", 60000],
  ["genexa-router-handled", "4-59/10 * * * *", "router-handled", 120000], // Triage items we already answered in Slack
];
// name, job, timezone, local hour, local minute, weekday (0 = Sunday, null = daily), timeout ms
const LOCAL = [
  ["genexa-cortana-full", "cortana-full", "America/New_York", 2, 30, null, 290000],
  ["genexa-mercury-sync", "mercury-sync", "America/New_York", 6, 0, null, 120000],
  ["genexa-daily-snapshot", "daily-snapshot", "America/New_York", 0, 5, null, 120000],
  ["genexa-pay-run", "pay-run", "America/New_York", 23, 59, 0, 120000], // Sunday 23:59 ET, after every shift has closed
];
// Offsets from UTC, in hours, that each timezone can have.
const OFFSETS = { "America/New_York": [4, 5], "Europe/London": [0, -1] };
const SCHEDULES = [
  ...INTERVAL.map(([name, cron, job, timeout]) => [name, cron, job, timeout, ""]),
  ...LOCAL.map(([name, job, tz, hour, minute, dow, timeout]) => {
    const utcHours = OFFSETS[tz].map((o) => (hour + o + 24) % 24).join(",");
    const query = `?tz=${encodeURIComponent(tz)}&hour=${hour}${dow === null ? "" : `&dow=${dow}`}`;
    return [name, `${minute} ${utcHours} * * *`, job, timeout, query];
  }),
];
// No longer scheduled: weekly client reports are not wanted.
const RETIRED = ["genexa-weekly-client-report"];

// The pooler presents Supabase's own CA; drop sslmode from the URL so the ssl option below applies.
const dbUrl = new URL(need("SUPABASE_DB_URL"));
dbUrl.searchParams.delete("sslmode");
const client = new pg.Client({ connectionString: dbUrl.toString(), ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query("create extension if not exists pg_cron");
  await client.query("create extension if not exists pg_net");
  const existing = await client.query("select id from vault.secrets where name = 'genexa_cron_secret'");
  if (existing.rows.length) await client.query("select vault.update_secret($1, $2)", [existing.rows[0].id, secret]);
  else await client.query("select vault.create_secret($1, 'genexa_cron_secret', 'Bearer token pg_cron sends to /api/jobs/*')", [secret]);

  for (const [name, schedule, job, timeout, query] of SCHEDULES) {
    const command = `select net.http_post(
      url := '${appUrl}/api/jobs/${job}${query}',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
        'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'genexa_cron_secret')),
      body := '{}'::jsonb,
      timeout_milliseconds := ${timeout});`;
    await client.query("select cron.schedule($1, $2, $3)", [name, schedule, command]);
  }
  for (const name of RETIRED) {
    await client.query("select cron.unschedule(jobid) from cron.job where jobname = $1", [name]);
  }
  const jobs = await client.query("select jobname, schedule, active from cron.job where jobname like 'genexa-%' order by jobname");
  console.log(`Jobs call ${appUrl}`);
  for (const j of jobs.rows) console.log(`  ${j.jobname.padEnd(22)} ${j.schedule.padEnd(14)} active=${j.active}`);
} finally {
  await client.end();
}
