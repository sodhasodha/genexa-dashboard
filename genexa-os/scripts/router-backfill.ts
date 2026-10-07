/**
 * Read the last N days of every client channel and find the requests in them:
 *   npm run router:backfill -- --days 14
 * Silent: nothing is posted, no clinic record changes and no task is created.
 * Requests wait on the router page ("Backfill requests awaiting approval").
 */
import { createClient } from "@supabase/supabase-js";
import { runBackfill, type BackfillChannel } from "../lib/router/backfill";
import { ROUTER_MODEL, classifyMessage } from "../lib/router/classify";
import { SlackApiError, fetchChannelHistory, fetchSlackUser } from "../lib/router/slack";

const stop = (message: string): never => {
  console.error(message);
  process.exit(1);
};

function daysArg(): number {
  const i = process.argv.indexOf("--days");
  const n = i === -1 ? 14 : Number(process.argv[i + 1]);
  return Number.isInteger(n) && n > 0 && n <= 90 ? n : stop("--days must be a whole number from 1 to 90.");
}

async function main() {
  const days = daysArg();
  // Checked before anything is read: without the model nothing could be classified.
  const apiKey = process.env.ANTHROPIC_API_KEY || stop("ANTHROPIC_API_KEY is not set. The backfill needs it to classify messages. Nothing was read or stored.");
  const token = process.env.SLACK_CLIENT_BOT_TOKEN || stop("SLACK_CLIENT_BOT_TOKEN is not set (the client workspace install's bot token). Nothing was read or stored.");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || stop("Missing environment variable: NEXT_PUBLIC_SUPABASE_URL");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || stop("Missing environment variable: SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: clients, error } = await db.from("clients").select("name, slack_general_id, slack_scheduling_id").is("deleted_at", null).order("name");
  if (error) stop(`Could not read clients: ${error.message}`);
  const channels: BackfillChannel[] = (clients ?? []).flatMap((c) => [
    ...(c.slack_general_id ? [{ clientName: c.name as string, channel: c.slack_general_id as string, kind: "general" as const }] : []),
    ...(c.slack_scheduling_id ? [{ clientName: c.name as string, channel: c.slack_scheduling_id as string, kind: "scheduling" as const }] : []),
  ]);
  if (channels.length === 0) stop("No client has a General or Scheduling channel id set. Nothing to read.");

  console.log(`Reading ${channels.length} client channels, last ${days} days. Classifying with ${ROUTER_MODEL}.`);
  const r = await runBackfill({
    rpc: async <T>(fn: string, args?: Record<string, unknown>) => {
      const { data, error: e } = await db.rpc(fn, args ?? {});
      if (e) throw new Error(`${fn}: ${e.message}`);
      return data as T;
    },
    channels,
    days,
    history: (channel, oldest) => fetchChannelHistory(channel, oldest, { token }),
    lookupUser: (userId) => fetchSlackUser(userId, { token }),
    classify: (input) => classifyMessage(input, { apiKey }),
    log: (line) => console.log(line),
  });

  console.log(`\n${r.read} messages read · ${r.stored} new client messages stored · ${r.alreadyStored} already stored · ${r.ignored} ignored (staff, bots, edits, joins) · ${r.failed} not classified yet (the router-process job retries them)`);
  for (const s of r.skippedChannels) console.log(`Skipped ${s.clinic} ${s.channel}: Slack said ${s.error}${s.error === "not_in_channel" ? " (add the app to the channel)" : ""}`);
  if (r.requests.length === 0) {
    console.log("\nNo requests found.");
  } else {
    console.log(`\n${r.requests.length} requests found:`);
    console.table(r.requests.map((q) => ({ ...q, confidence: q.confidence.toFixed(2), title: q.title.slice(0, 70) })));
    console.log("pending_approval = waiting for Approve / Reject on /router. triage = waiting in Data review -> Triage. Nothing has been created.");
  }
}

main().catch((err) => {
  if (err instanceof SlackApiError && err.code === "missing_scope") {
    stop(`Slack refused ${err.method}: missing_scope. The client workspace install lacks channels:history / groups:history (or users:read). Reinstall it from slack-client-app-manifest.yaml, then run this again. Nothing was created.`);
  }
  if (err instanceof SlackApiError) stop(`Slack refused ${err.method}: ${err.code}. Nothing was created.`);
  console.error(err);
  process.exit(1);
});
