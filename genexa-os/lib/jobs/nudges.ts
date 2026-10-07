import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { etToday } from "@/lib/time";

export type NudgeSender = (channel: string, text: string) => Promise<{ ok: boolean; ts?: string; error?: string }>;

/** Posts in a client-workspace channel with the client install's token. Used for outcome nudges only. */
const postToClientChannel: NudgeSender = async (channel, text) => {
  const token = process.env.SLACK_CLIENT_BOT_TOKEN;
  if (!token) return { ok: false, error: "client_workspace_not_configured" };
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, text, unfurl_links: false }),
  });
  const json = (await res.json()) as { ok: boolean; ts?: string; error?: string };
  return { ok: json.ok, ts: json.ts, error: json.error };
};

export const nudgeText = (waiting: number, consults: string) =>
  `${waiting} ${waiting === 1 ? "consult is" : "consults are"} waiting for an outcome: ${consults}. Please log whether each patient showed, so your results stay accurate.`;

/**
 * Outcome nudges: one message per clinic, in its own channel, saying how many
 * consults are waiting for an outcome. Never more than once every 7 days per
 * clinic. This is the only message the app posts in the client workspace
 * besides request-router thread replies.
 */
export async function runOutcomeNudges(opts: { db?: SupabaseClient; send?: NudgeSender; today?: string } = {}) {
  const db = opts.db ?? createAdminClient();
  const send = opts.send ?? postToClientChannel;
  const summary = { enabled: true, due: 0, sent: 0, skipped_recent: 0, skipped_no_channel: 0, failed: 0, clinics: [] as string[] };
  const { data: setting } = await db.from("app_settings").select("value").eq("key", "client_outcome_nudges").maybeSingle();
  const { data: rule } = await db.from("reminder_rules").select("enabled").eq("key", "outcome_nudge").maybeSingle();
  if (setting?.value !== true || rule?.enabled === false) return { ok: true, summary: { ...summary, enabled: false } };

  const { data, error } = await db.from("outcome_nudges_due").select("client_id, name, channel, waiting, consults, last_nudged_at");
  if (error) throw new Error(`outcome_nudges_due: ${error.message}`);
  const window = opts.today ?? etToday();
  for (const row of data ?? []) {
    summary.due++;
    if (!row.channel) { summary.skipped_no_channel++; continue; }
    if (row.last_nudged_at && Date.now() - new Date(row.last_nudged_at as string).getTime() < 6.5 * 86_400_000) { summary.skipped_recent++; continue; }
    // The row is written first: the unique index stops a second message for the same clinic and day.
    const { data: note, error: noteError } = await db.from("notifications")
      .insert({ rule_key: "outcome_nudge", channel: row.channel, record_type: "clients", record_id: row.client_id, window_key: window })
      .select("id").single();
    if (noteError || !note) { summary.skipped_recent++; continue; }
    const r = await send(row.channel as string, nudgeText(Number(row.waiting), row.consults as string));
    if (r.ok) {
      await db.from("notifications").update({ sent_at: new Date().toISOString(), slack_ts: r.ts ?? "sent" }).eq("id", note.id);
      summary.sent++;
      summary.clinics.push(`${row.name} (${row.waiting})`);
    } else {
      await db.from("notifications").update({ sent_at: new Date().toISOString(), channel: `${row.channel}`, slack_ts: null, window_key: `${window}:failed:${r.error ?? "error"}` }).eq("id", note.id);
      summary.failed++;
    }
  }
  return { ok: summary.failed === 0, summary };
}

export const JOBS_NUDGES: Record<string, () => Promise<{ ok: boolean; summary: Record<string, unknown> }>> = {
  "outcome-nudges": () => runOutcomeNudges(),
};
