import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appUrl } from "@/lib/env";
import { lookupUserIdByEmail, postMessage, slackConfigured } from "@/lib/slack/client";
import { deliverReminders, supabaseRpc } from "@/lib/reminders/engine";

export type EngineResult = {
  opened: number;
  refreshed: number;
  resolved: number;
  notified: number;
  /** Waiting for the owner's shift, or for a Slack account to match. */
  held: number;
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

  // Every newly opened exception gets one notification row for its owner (the
  // unique index refuses a second). Rows are then delivered when allowed:
  // urgent rules at once, everything else only while the owner is on shift.
  // A held row goes out on a later run, once the shift has started, if the
  // exception is still open. No shift entered = held until one is.
  let notified = 0;
  let held = 0;
  if (openedIds.length > 0) {
    const { data: opened } = await db.from("exceptions").select("id, owner_id").in("id", openedIds).not("owner_id", "is", null);
    for (const ex of opened ?? []) {
      await db.from("notifications").insert({ rule_key: "exception_opened", staff_id: ex.owner_id, record_type: "exceptions", record_id: ex.id });
    }
  }
  if (slackConfigured()) {
    // Delivery is the reminder engine's (reminders_deliverable, 0027): the same
    // rules as above, with Done / Snooze 1h buttons on each exception.
    const delivered = await deliverReminders({
      rpc: supabaseRpc(db),
      send: postMessage,
      lookupUserIdByEmail,
      appUrl: appUrl(),
      rule: "exception_opened",
      pauseMs: 1100, // Slack allows about one message a second
    });
    notified = delivered.sent;
    held = delivered.held;
  }

  const result: EngineResult = {
    opened: count("opened"),
    refreshed: count("refreshed"),
    resolved: count("resolved"),
    notified,
    held,
    slack: slackConfigured() ? "sent" : "not_configured",
  };
  await db.from("job_runs").insert({ job: "exceptions", started_at: startedAt, finished_at: new Date().toISOString(), ok: true, rows_processed: rows.length });
  return result;
}
