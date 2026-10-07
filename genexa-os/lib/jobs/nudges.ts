import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

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

/** The one batched message a clinic gets: new consults in full, second reminders in one short line. */
export function nudgeText(first: { count: number; list: string | null }, second: { count: number; list: string | null }): string {
  const parts: string[] = [];
  if (first.count > 0) {
    parts.push(`${first.count} ${first.count === 1 ? "consult needs" : "consults need"} an outcome logged (showed, no-show or cancelled):\n${(first.list ?? "").split("\n").map((l) => `• ${l}`).join("\n")}`);
  }
  if (second.count > 0) parts.push(`Second reminder, still waiting: ${second.list}`);
  return parts.join("\n\n");
}

/** The clinic-local hour the daily message goes out. */
export const NUDGE_HOUR = 10;

/**
 * Outcome nudges, run every hour. A clinic gets at most one message a day, at
 * 10:00 its own time: every consult that passed 24h with no outcome since the
 * last message, plus a short second reminder for those now past 48h. After two
 * reminders a consult is not mentioned again. Besides request-router thread
 * replies, this is the only thing the app posts in the client workspace.
 */
export async function runOutcomeNudges(opts: { db?: SupabaseClient; send?: NudgeSender; hour?: number } = {}) {
  const db = opts.db ?? createAdminClient();
  const send = opts.send ?? postToClientChannel;
  const summary = { enabled: true, clinics_due: 0, sent: 0, first: 0, second: 0, not_their_hour: 0, already_today: 0, no_channel: [] as string[], failed: [] as string[] };
  const { data: setting } = await db.from("app_settings").select("value").eq("key", "client_outcome_nudges").maybeSingle();
  const { data: rule } = await db.from("reminder_rules").select("enabled").eq("key", "outcome_nudge").maybeSingle();
  if (setting?.value !== true || rule?.enabled === false) return { ok: true, summary: { ...summary, enabled: false } };

  const { data, error } = await db.from("outcome_nudges_due").select("*");
  if (error) throw new Error(`outcome_nudges_due: ${error.message}`);
  for (const row of data ?? []) {
    if (Number(row.local_hour) !== (opts.hour ?? NUDGE_HOUR)) { summary.not_their_hour++; continue; }
    summary.clinics_due++;
    if (!row.channel) { summary.no_channel.push(row.name as string); continue; }
    // Written first: the unique index allows one message per clinic per local day.
    const { data: note, error: noteError } = await db.from("notifications")
      .insert({ rule_key: "outcome_nudge", channel: row.channel, record_type: "clients", record_id: row.client_id, window_key: row.local_date })
      .select("id").single();
    if (noteError || !note) { summary.already_today++; continue; }
    const first = { count: Number(row.first_count), list: row.first_list as string | null };
    const second = { count: Number(row.second_count), list: row.second_list as string | null };
    const r = await send(row.channel as string, nudgeText(first, second));
    const now = new Date().toISOString();
    if (!r.ok) {
      // Freed so the next hourly run can try again the same day.
      await db.from("notifications").update({ window_key: `${row.local_date}:failed:${now}`, sent_at: now }).eq("id", note.id);
      summary.failed.push(`${row.name}: ${r.error ?? "error"}`);
      continue;
    }
    await db.from("notifications").update({ sent_at: now, slack_ts: r.ts ?? "sent" }).eq("id", note.id);
    if (first.count > 0) await db.from("appointments").update({ nudge1_at: now }).in("id", row.first_ids as string[]);
    if (second.count > 0) await db.from("appointments").update({ nudge2_at: now }).in("id", row.second_ids as string[]);
    summary.sent++;
    summary.first += first.count;
    summary.second += second.count;
  }
  return { ok: summary.failed.length === 0, summary };
}

export const JOBS_NUDGES: Record<string, () => Promise<{ ok: boolean; summary: Record<string, unknown> }>> = {
  "outcome-nudges": () => runOutcomeNudges(),
};
