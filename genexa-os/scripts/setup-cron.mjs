// Schedules the app's jobs in Supabase (pg_cron + pg_net). Re-runnable.
//   npm run setup:cron
// pg_cron calls POST {APP_URL}/api/jobs/<job> with "Authorization: Bearer CRON_SECRET".
// The secret lives in Supabase Vault, never in a migration or in git.
// pg_cron runs in UTC, so ET times drift an hour between summer and winter time.
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

// name, cron (UTC), job, timeout ms
const SCHEDULES = [
  ["genexa-cortana-sync", "5 * * * *", "cortana-sync", 290000], // hourly, all day, so the source never looks stale overnight
  ["genexa-cortana-full", "30 6 * * *", "cortana-full", 290000], // 02:30 ET (01:30 in winter): re-read the last 4 days
  ["genexa-cortana-events", "35 * * * *", "cortana-events", 290000], // funnel + outcomes, hourly, offset from the ad sync
  ["genexa-whop-sync", "20 * * * *", "whop-sync", 120000],
  ["genexa-exceptions", "*/15 * * * *", "exceptions", 60000],
];

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

  for (const [name, schedule, job, timeout] of SCHEDULES) {
    const command = `select net.http_post(
      url := '${appUrl}/api/jobs/${job}',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
        'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'genexa_cron_secret')),
      body := '{}'::jsonb,
      timeout_milliseconds := ${timeout});`;
    await client.query("select cron.schedule($1, $2, $3)", [name, schedule, command]);
  }
  const jobs = await client.query("select jobname, schedule, active from cron.job where jobname like 'genexa-%' order by jobname");
  console.log(`Jobs call ${appUrl}`);
  for (const j of jobs.rows) console.log(`  ${j.jobname.padEnd(22)} ${j.schedule.padEnd(14)} active=${j.active}`);
} finally {
  await client.end();
}
