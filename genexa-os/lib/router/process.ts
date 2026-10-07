// After a message is stored: classify it, route it (SQL), and send what is due.
// Slack, the model and the database are all passed in.
import type { Rpc } from "../jobs/rpc";
import type { Classification, ClassifyInput } from "./classify";
import { DONE_TEXT, loggedReplyText, type ClientThreadText } from "./replies";

export type ThreadReply = (opts: { channel: string; threadTs: string; text: ClientThreadText; repliesEnabled: boolean }) => Promise<{ ok: boolean; error?: string; ts?: string }>;

export type ProcessDeps = {
  rpc: Rpc;
  classify: (input: ClassifyInput) => Promise<Classification>;
  /** Posts inside a thread in the client workspace (replyInClientThread). */
  reply: ThreadReply;
  /** Sends the owner's exception DMs that may go out now, in the TEAM workspace. */
  deliverOwnerDms?: () => Promise<unknown>;
  now?: Date;
};

export type RouteResult = {
  id: string; status: string; mode: "live" | "backfill"; owner: string | null;
  routed_table: string | null; routed_id: string | null; merged_into: string | null;
  triage_reason: string | null; urgent_dm: boolean;
};

type Claim = { id: string; text: string; channel_kind: "general" | "scheduling"; received_at: string; mode: "live" | "backfill"; client_name: string; timezone: string };

export type ProcessResult =
  | { outcome: "skipped" }
  | { outcome: "failed"; status: string | null; error: string }
  | { outcome: "routed"; result: RouteResult; classification: Classification };

/** Classify and route one stored message. Safe to call twice: the second call finds nothing to claim. */
export async function processRequest(id: string, deps: ProcessDeps): Promise<ProcessResult> {
  const claim = await deps.rpc<Claim | null>("router_claim", { p_id: id, p_now: (deps.now ?? new Date()).toISOString() });
  if (!claim) return { outcome: "skipped" };

  let c: Classification;
  try {
    c = await deps.classify({ text: claim.text, clientName: claim.client_name, timezone: claim.timezone, channelKind: claim.channel_kind, sentAt: new Date(claim.received_at) });
  } catch (err) {
    const error = (err as Error).message;
    const status = await deps.rpc<string | null>("router_classify_failed", { p_id: id, p_error: error });
    return { outcome: "failed", status, error };
  }

  const result = await deps.rpc<RouteResult>("route_client_request", {
    p_id: id, p_is_request: c.is_request, p_owner: c.owner, p_title: c.title, p_due_at: c.due_at,
    p_urgency: c.urgency, p_confidence: c.confidence, p_tech_type: c.tech_type,
  });
  await afterRouting(result, deps);
  return { outcome: "routed", result, classification: c };
}

/** What follows a routing decision: the owner's urgent DM, and the "Logged" thread reply. */
export async function afterRouting(result: RouteResult, deps: Pick<ProcessDeps, "rpc" | "reply" | "deliverOwnerDms">): Promise<void> {
  if (result.urgent_dm && deps.deliverOwnerDms) await deps.deliverOwnerDms().catch((err) => console.error("router: owner DM failed", err));
  if (result.status === "routed" && result.mode === "live") await sendDueReplies(deps).catch((err) => console.error("router: thread reply failed", err));
}

export type PendingResult = { picked: number; routed: number; triage: number; not_request: number; merged: number; pending_approval: number; failed: number };

/** Everything stored but not yet classified (after() was cut short, or the model failed earlier). */
export async function processPending(deps: ProcessDeps, limit = 20): Promise<PendingResult> {
  const ids = (await deps.rpc<string[]>("router_pending", { p_limit: limit, p_now: (deps.now ?? new Date()).toISOString() })) ?? [];
  const out: PendingResult = { picked: ids.length, routed: 0, triage: 0, not_request: 0, merged: 0, pending_approval: 0, failed: 0 };
  for (const id of ids) {
    const r = await processRequest(id, deps);
    if (r.outcome === "failed") out.failed++;
    else if (r.outcome === "routed" && r.result.status in out) out[r.result.status as "routed" | "triage" | "not_request" | "merged" | "pending_approval"]++;
  }
  return out;
}

type DueReply = { id: string; kind: "logged" | "done"; channel: string; thread_ts: string; owner_name: string | null; title: string | null; due_at: string | null; timezone: string };

export type RepliesResult = { enabled: boolean; sent: number; failed: number };

/**
 * Sends the thread replies that are due: "Logged ✓ ..." for a routed request,
 * "Done ✓" once its work is closed. With the setting off the database returns
 * nothing and Slack is never called.
 */
export async function sendDueReplies(deps: Pick<ProcessDeps, "rpc" | "reply">): Promise<RepliesResult> {
  const due = await deps.rpc<{ enabled: boolean; items: DueReply[] }>("router_replies_due", {});
  const out: RepliesResult = { enabled: !!due?.enabled, sent: 0, failed: 0 };
  if (!due?.enabled) return out;
  for (const item of due.items ?? []) {
    if (item.kind === "logged" && (!item.owner_name || !item.title)) continue;
    const text = item.kind === "done" ? DONE_TEXT : loggedReplyText({ ownerName: item.owner_name!, title: item.title!, dueAt: item.due_at, timezone: item.timezone });
    // Claim first: a reply another run has already taken is not sent again.
    if (!(await deps.rpc<boolean>("router_reply_claim", { p_id: item.id, p_kind: item.kind }))) continue;
    let sent: { ok: boolean; error?: string; ts?: string };
    try {
      sent = await deps.reply({ channel: item.channel, threadTs: item.thread_ts, text, repliesEnabled: due.enabled });
    } catch (err) {
      sent = { ok: false, error: (err as Error).message };
    }
    // A failed send is released (null) and tried again on the next run.
    await deps.rpc("router_reply_finish", { p_id: item.id, p_kind: item.kind, p_ts: sent.ok ? (sent.ts ?? "sent") : null });
    if (sent.ok) out.sent++;
    else out.failed++;
  }
  return out;
}
