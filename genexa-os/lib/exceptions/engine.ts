import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appUrl } from "@/lib/env";
import { lookupUserIdByEmail, postMessage, slackConfigured } from "@/lib/slack/client";

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
    const { data: pending } = await db
      .from("notifications")
      .select("id, staff_id, record_id")
      .eq("rule_key", "exception_opened")
      .is("sent_at", null)
      .order("created_at")
      .limit(200);
    const ids = (pending ?? []).map((p) => p.record_id).filter((x): x is string => !!x);
    const { data: exceptions } = ids.length
      ? await db.from("exceptions").select("id, type, status, severity, reason, money_at_risk").in("id", ids)
      : { data: [] };
    const { data: rules } = await db.from("exception_rules").select("type, urgent");
    const urgent = new Set((rules ?? []).filter((r) => r.urgent).map((r) => r.type));
    const onShift = new Map<string, boolean>();
    const slackIds = new Map<string, string | null>();
    let n = 0;
    for (const note of pending ?? []) {
      const ex = exceptions?.find((e) => e.id === note.record_id);
      if (!ex || !note.staff_id) continue;
      if (ex.status === "resolved") {
        // Cleared before the owner's shift: nothing to tell them. Mark it so it is not picked up again.
        await db.from("notifications").update({ sent_at: new Date().toISOString(), channel: "skipped:resolved" }).eq("id", note.id);
        continue;
      }
      if (!urgent.has(ex.type)) {
        if (!onShift.has(note.staff_id)) {
          const { data: on } = await db.rpc("staff_on_shift", { p_staff: note.staff_id });
          onShift.set(note.staff_id, on === true);
        }
        if (!onShift.get(note.staff_id)) {
          held++;
          continue;
        }
      }
      if (!slackIds.has(note.staff_id)) {
        const { data: owner } = await db.from("staff").select("email, slack_user_id").eq("id", note.staff_id).single();
        let slackId = owner?.slack_user_id ?? null;
        if (!slackId && owner?.email) {
          slackId = await lookupUserIdByEmail(owner.email);
          if (slackId) await db.from("staff").update({ slack_user_id: slackId }).eq("id", note.staff_id);
        }
        slackIds.set(note.staff_id, slackId);
      }
      const slackId = slackIds.get(note.staff_id);
      if (!slackId) {
        held++;
        continue;
      }
      if (n++ > 0) await new Promise((r) => setTimeout(r, 1100)); // Slack allows about one message a second
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
    held,
    slack: slackConfigured() ? "sent" : "not_configured",
  };
  await db.from("job_runs").insert({ job: "exceptions", started_at: startedAt, finished_at: new Date().toISOString(), ok: true, rows_processed: rows.length });
  return result;
}
