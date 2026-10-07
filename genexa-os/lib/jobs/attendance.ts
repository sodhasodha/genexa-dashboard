import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appUrl } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { lookupUserIdByEmail, postMessage, slackConfigured, type SlackResult } from "@/lib/slack/client";

export type AttendanceSender = (slackUserId: string, text: string) => Promise<SlackResult>;

export type AttendanceJobOptions = {
  db: SupabaseClient;
  /** Delivers one Slack DM. Defaults to the real Slack client. */
  send?: AttendanceSender;
  /** Whether Slack can be used at all. Defaults to "the bot token is set". */
  slackReady?: boolean;
  /** Finds a Slack user id from an email when staff.slack_user_id is empty. */
  lookup?: (email: string) => Promise<string | null>;
  /** Gap between messages; Slack allows about one a second. */
  pauseMs?: number;
};

type TickRow = { attendance_id: string; staff_id: string; old_status: string | null; new_status: string | null };

/** One row of attendance_alerts_due: an alert not yet recorded in notifications. */
type AlertDue = {
  attendance_id: string;
  staff_id: string;
  first_name: string;
  status: "late" | "no_show";
  minutes_late: number | null;
  clocked_in: boolean;
  shift_start_label: string;
  rule_key: "attendance_late" | "attendance_no_show";
  recipient_id: string;
  recipient_slack_id: string | null;
  recipient_email: string | null;
  late_minutes: number;
  no_show_minutes: number;
};

/** First name + what happened + the link. Wording only: every number comes from the view. */
export function alertText(a: AlertDue, url: string): string {
  const link = `${url}/team`;
  if (a.rule_key === "attendance_late") {
    return a.clocked_in && a.minutes_late !== null
      ? `${a.first_name}, you clocked in ${a.minutes_late} min late (shift start ${a.shift_start_label}).\n${link}`
      : `${a.first_name}, you have not clocked in. Your shift started at ${a.shift_start_label} and you are marked late. Clock in now.\n${link}`;
  }
  const after = a.clocked_in && a.minutes_late !== null ? ` They clocked in ${a.minutes_late} min after the start.` : "";
  return `No-show: ${a.first_name} had not clocked in ${a.no_show_minutes} minutes after their ${a.shift_start_label} shift start.${after}\n${link}`;
}

/**
 * Runs the SQL tick (attendance_tick), then delivers the alerts it leaves due:
 * late -> the person; no-show -> the media buyer and the owner, at once.
 * Each alert is written to notifications BEFORE it is sent, and the unique
 * index on that table refuses a second row, so a repeat run never sends twice.
 */
export async function runAttendance(opts: AttendanceJobOptions): Promise<{ ok: boolean; summary: Record<string, unknown> }> {
  const { db } = opts;
  const send = opts.send ?? ((to, text) => postMessage(to, text));
  const slackReady = opts.slackReady ?? slackConfigured();
  const lookup = opts.lookup ?? lookupUserIdByEmail;
  const pauseMs = opts.pauseMs ?? 1100;
  const startedAt = new Date().toISOString();
  const finish = async (ok: boolean, rows: number, error?: string) => {
    await db.from("job_runs").insert({ job: "attendance", started_at: startedAt, finished_at: new Date().toISOString(), ok, rows_processed: rows, error: error ?? null });
  };

  const tick = await db.rpc("attendance_tick");
  if (tick.error) {
    await finish(false, 0, tick.error.message);
    return { ok: false, summary: { error: `attendance_tick: ${tick.error.message}` } };
  }
  const changes = (tick.data ?? []) as TickRow[];

  const due = await db.from("attendance_alerts_due").select("*");
  if (due.error) {
    await finish(false, changes.length, due.error.message);
    return { ok: false, summary: { error: `attendance_alerts_due: ${due.error.message}` } };
  }

  let sent = 0;
  let failed = 0;
  let skippedNoSlackUser = 0;
  let skippedNotConfigured = 0;
  let alreadyRecorded = 0;
  const slackIds = new Map<string, string | null>();

  for (const alert of (due.data ?? []) as AlertDue[]) {
    const note = await db
      .from("notifications")
      .insert({ rule_key: alert.rule_key, staff_id: alert.recipient_id, record_type: "attendance", record_id: alert.attendance_id })
      .select("id")
      .single();
    if (note.error || !note.data) {
      // Another run recorded it first: that run owns the send.
      alreadyRecorded++;
      continue;
    }
    const noteId = (note.data as { id: string }).id;
    const mark = (patch: Record<string, unknown>) => db.from("notifications").update(patch).eq("id", noteId);

    if (!slackReady) {
      skippedNotConfigured++;
      await mark({ channel: "skipped:slack_not_configured" });
      continue;
    }
    if (!slackIds.has(alert.recipient_id)) {
      let slackId = alert.recipient_slack_id;
      if (!slackId && alert.recipient_email) {
        slackId = await lookup(alert.recipient_email);
        if (slackId) await db.from("staff").update({ slack_user_id: slackId }).eq("id", alert.recipient_id);
      }
      slackIds.set(alert.recipient_id, slackId ?? null);
    }
    const slackId = slackIds.get(alert.recipient_id);
    if (!slackId) {
      skippedNoSlackUser++;
      await mark({ channel: "skipped:no_slack_user" });
      continue;
    }
    if (sent + failed > 0 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    const result = await send(slackId, alertText(alert, appUrl()));
    if (result.ok) {
      sent++;
      await mark({ sent_at: new Date().toISOString(), slack_ts: result.ts, channel: result.channel });
    } else {
      failed++;
      await mark({ channel: `failed:${result.error}`.slice(0, 200) });
    }
  }

  const became = (status: string) => changes.filter((c) => c.new_status === status).length;
  await finish(failed === 0, changes.length, failed > 0 ? `${failed} Slack sends failed` : undefined);
  return {
    ok: failed === 0,
    summary: {
      status_changes: changes.length,
      late: became("late"),
      no_show: became("no_show"),
      excused: became("excused"),
      sent,
      failed,
      skipped_no_slack_user: skippedNoSlackUser,
      skipped_slack_not_configured: skippedNotConfigured,
      already_recorded: alreadyRecorded,
    },
  };
}

/** Scheduled every 5 minutes. */
export const JOBS_ATTENDANCE: Record<string, () => Promise<{ ok: boolean; summary: Record<string, unknown> }>> = {
  attendance: () => runAttendance({ db: createAdminClient() }),
};
