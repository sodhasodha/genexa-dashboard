/**
 * Clear Triage items we have already answered in Slack:
 *   npm run router:handled
 * For every client channel with open Triage items, reads the channel (and the
 * threads those items are in) and marks an item "Handled in Slack" when a Genexa
 * staff member replied in its thread or posted in the channel after it.
 * Read-only towards Slack: nothing is posted. Nothing is deleted: handled items
 * are listed on the router page.
 */
import { createClient } from "@supabase/supabase-js";
import { sweepHandled } from "../lib/router/handled";
import { SlackApiError, fetchChannelHistory, fetchSlackUser, fetchThreadReplies } from "../lib/router/slack";

const stop = (message: string): never => {
  console.error(message);
  process.exit(1);
};

async function main() {
  const token = process.env.SLACK_CLIENT_BOT_TOKEN || stop("SLACK_CLIENT_BOT_TOKEN is not set (the client workspace install's bot token). Nothing was read or changed.");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || stop("Missing environment variable: NEXT_PUBLIC_SUPABASE_URL");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || stop("Missing environment variable: SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const r = await sweepHandled({
    rpc: async <T>(fn: string, args?: Record<string, unknown>) => {
      const { data, error: e } = await db.rpc(fn, args ?? {});
      if (e) throw new Error(`${fn}: ${e.message}`);
      return data as T;
    },
    history: (channel, oldest) => fetchChannelHistory(channel, oldest, { token }),
    replies: (channel, threadTs) => fetchThreadReplies(channel, threadTs, { token }),
    lookupUser: (userId) => fetchSlackUser(userId, { token }),
    log: (line) => console.log(line),
  });

  if (r.channels === 0) {
    console.log("No open Triage items. Nothing to check.");
    return;
  }
  console.log(`${r.channels} channels with open Triage items · ${r.read} Slack messages read · ${r.handled} items marked "Handled in Slack"`);
  console.table(r.byClinic);
  for (const s of r.skippedChannels) console.log(`Skipped ${s.clinic} ${s.channel}: Slack said ${s.error}${s.error === "not_in_channel" ? " (add the app to the channel)" : ""}`);
}

main().catch((err) => {
  if (err instanceof SlackApiError && err.code === "missing_scope") {
    stop(`Slack refused ${err.method}: missing_scope. The client workspace install lacks channels:history / groups:history (or users:read). Reinstall it from slack-client-app-manifest.yaml, then run this again.`);
  }
  if (err instanceof SlackApiError) stop(`Slack refused ${err.method}: ${err.code}.`);
  console.error(err);
  process.exit(1);
});
