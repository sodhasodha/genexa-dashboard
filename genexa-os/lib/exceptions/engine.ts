import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appUrl } from "@/lib/env";
import { lookupUserIdByEmail, postMessage, slackConfigured } from "@/lib/slack/client";

export type EngineResult = {
  opened: number;
  refreshed: number;
  resolved: number;
  notified: number;
  slack: "sent" | "not_configured";
};

/**
 * Runs the SQL engine (run_exceptions_engine), then DMs the owner of each
 * newly opened exception. All detection logic lives in SQL; this only delivers.
 */
export async function runExceptionsEngine(db: SupabaseClient): Promise<EngineResult> {
  const startedAt = new Date().toISOString();
  const { data, error } = await db.rpc("run_exceptions_engine");
  if (error) {
    await db.from("job_runs").insert({ job: "exceptions", started_at: startedAt, finished_at: new Date().toISOString(), ok: false, error: error.message });
    throw new Error(`run_exceptions_engine: ${error.message}`);
  }
  const rows = (data ?? []) as { exception_id: string; action: string; exception_type: string }[];
  const count = (action: string) => rows.filter((r) => r.action === action).length;
  const openedIds = rows.filter((r) => r.action === "opened").map((r) => r.exception_id);

  let notified = 0;
  if (openedIds.length > 0 && slackConfigured()) {
    const { data: opened } = await db
      .from("exceptions")
      .select("id, type, severity, reason, money_at_risk, owner:staff!exceptions_owner_id_fkey(id, email, slack_user_id)")
      .in("id", openedIds);
    for (const ex of opened ?? []) {
      const owner = (Array.isArray(ex.owner) ? ex.owner[0] : ex.owner) as { id: string; email: string | null; slack_user_id: string | null } | null;
      if (!owner) continue;
      let slackId = owner.slack_user_id;
      if (!slackId && owner.email) {
        slackId = await lookupUserIdByEmail(owner.email);
        if (slackId) await db.from("staff").update({ slack_user_id: slackId }).eq("id", owner.id);
      }
      if (!slackId) continue;
      // The dedupe index makes this insert fail if this exception was already sent to this person.
      const { data: note, error: noteError } = await db
        .from("notifications")
        .insert({ rule_key: "exception_opened", staff_id: owner.id, record_type: "exceptions", record_id: ex.id })
        .select("id")
        .single();
      if (noteError || !note) continue;
      const money = Number(ex.money_at_risk ?? 0) > 0 ? ` · $${Number(ex.money_at_risk).toLocaleString("en-US")} at risk` : "";
      const sent = await postMessage(slackId, `${ex.severity === "red" ? "🔴" : "🟠"} ${ex.reason}${money}\n${appUrl()}/overview?exception=${ex.id}`);
      if (sent.ok) {
        await db.from("notifications").update({ sent_at: new Date().toISOString(), slack_ts: sent.ts, channel: sent.channel }).eq("id", note.id);
        notified++;
      }
    }
  }

  const result: EngineResult = {
    opened: count("opened"),
    refreshed: count("refreshed"),
    resolved: count("resolved"),
    notified,
    slack: slackConfigured() ? "sent" : "not_configured",
  };
  await db.from("job_runs").insert({ job: "exceptions", started_at: startedAt, finished_at: new Date().toISOString(), ok: true, rows_processed: rows.length });
  return result;
}
