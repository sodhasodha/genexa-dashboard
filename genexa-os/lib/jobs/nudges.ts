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

/** The whole message a clinic gets. A count and a link: no patient names. */
export function nudgeText(clinic: string, count: number, link: string): string {
  return `Hi ${clinic} 👋 You have ${count} patient ${count === 1 ? "outcome" : "outcomes"} waiting to be updated. Please log them here: ${link}. Thanks!`;
}

/** Mondays, at this clinic-local hour. */
export const NUDGE_HOUR = 10;
export const NUDGE_ISODOW = 1;

/**
 * Outcome nudges, run hourly on Mondays. A clinic with consults 24h+ past and no
 * outcome gets one short message in its General channel at 10:00 its own time,
 * and nothing for the rest of the week. Besides request-router thread replies,
 * this is the only thing the app posts in the client workspace.
 */
export async function runOutcomeNudges(opts: { db?: SupabaseClient; send?: NudgeSender; hour?: number; isodow?: number } = {}) {
  const db = opts.db ?? createAdminClient();
  const send = opts.send ?? postToClientChannel;
  const summary = { enabled: true, clinics_due: 0, sent: 0, outcomes: 0, not_their_time: 0, already_sent: 0, nothing_definite: [] as string[], no_channel: [] as string[], no_link: [] as string[], failed: [] as string[] };
  const { data: setting } = await db.from("app_settings").select("value").eq("key", "client_outcome_nudges").maybeSingle();
  const { data: rule } = await db.from("reminder_rules").select("enabled").eq("key", "outcome_nudge").maybeSingle();
  if (setting?.value !== true || rule?.enabled === false) return { ok: true, summary: { ...summary, enabled: false } };

  const { data, error } = await db.from("outcome_nudges_due").select("*");
  if (error) throw new Error(`outcome_nudges_due: ${error.message}`);
  for (const row of data ?? []) {
    if (Number(row.local_dow) !== (opts.isodow ?? NUDGE_ISODOW) || Number(row.local_hour) !== (opts.hour ?? NUDGE_HOUR)) { summary.not_their_time++; continue; }
    // Only consults that are definitely unlogged are counted; a clinic with none gets no message.
    if (Number(row.overdue_count) === 0) { summary.nothing_definite.push(row.name as string); continue; }
    summary.clinics_due++;
    if (!row.channel) { summary.no_channel.push(row.name as string); continue; }
    // Never send "log them here:" with nowhere to go.
    if (!row.link) { summary.no_link.push(row.name as string); continue; }
    // Written first: the unique index allows one message per clinic per local day.
    const { data: note, error: noteError } = await db.from("notifications")
      .insert({ rule_key: "outcome_nudge", channel: row.channel, record_type: "clients", record_id: row.client_id, window_key: row.local_date })
      .select("id").single();
    if (noteError || !note) { summary.already_sent++; continue; }
    const r = await send(row.channel as string, nudgeText(row.name as string, Number(row.overdue_count), row.link as string));
    const now = new Date().toISOString();
    if (!r.ok) {
      // Freed so the next hourly run can try again the same day.
      await db.from("notifications").update({ window_key: `${row.local_date}:failed:${now}`, sent_at: now }).eq("id", note.id);
      summary.failed.push(`${row.name}: ${r.error ?? "error"}`);
      continue;
    }
    await db.from("notifications").update({ sent_at: now, slack_ts: r.ts ?? "sent" }).eq("id", note.id);
    summary.sent++;
    summary.outcomes += Number(row.overdue_count);
  }
  return { ok: summary.failed.length === 0, summary };
}

export const JOBS_NUDGES: Record<string, () => Promise<{ ok: boolean; summary: Record<string, unknown> }>> = {
  "outcome-nudges": () => runOutcomeNudges(),
};
