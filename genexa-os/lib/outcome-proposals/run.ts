import "server-only";
// After a client message is stored: spot outcomes, look the patient up on the client dashboard, DM the owner a Confirm.
// And the other half: the owner's Confirm / Ignore click.
import type { SupabaseClient } from "@supabase/supabase-js";
import { postMessage, respondToInteraction, slackConfigured } from "@/lib/slack/client";
import { clientWorkspaceToken } from "@/lib/slack/workspaces";
import { fetchThreadReplies } from "@/lib/router/slack";
import { extractOutcomes, mightMentionOutcome } from "./extract";
import { proposalBlocks, outcomeText, type Candidate } from "./compose";

const DASHBOARD = () => process.env.CLIENT_DASHBOARD_URL || "https://client.genexascaling.com";
export const outcomeProposalsConfigured = () => !!(process.env.CLIENT_DASHBOARD_AGENT_TOKEN && process.env.ANTHROPIC_API_KEY && slackConfigured());

async function dashboard<T>(path: string, body: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${DASHBOARD()}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.CLIENT_DASHBOARD_AGENT_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(50_000),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as T };
}

/** The owner: the one staff member Genexa OS treats as Aryan. */
async function owner(db: SupabaseClient): Promise<{ name: string; slack_user_id: string } | null> {
  const { data } = await db.from("staff").select("name, slack_user_id, role, also_role").or("role.eq.owner,also_role.eq.owner").neq("status", "left").not("slack_user_id", "is", null).order("created_at").limit(1);
  return (data?.[0] as { name: string; slack_user_id: string } | undefined) ?? null;
}

type StoredMessage = { id: string; client_id: string; channel: string; thread_ts: string | null; text: string; permalink: string; mode: string; clients: { name: string; ghl_location_id: string | null; timezone?: string | null } | null };

export async function proposeOutcomes(requestId: string, db: SupabaseClient): Promise<{ proposed: number; reason?: string }> {
  if (!outcomeProposalsConfigured()) return { proposed: 0, reason: "not configured" };
  const { data: msg } = await db.from("client_requests").select("id, client_id, channel, thread_ts, text, permalink, mode, clients(name, ghl_location_id)").eq("id", requestId).maybeSingle<StoredMessage>();
  if (!msg || msg.mode !== "live" || !mightMentionOutcome(msg.text)) return { proposed: 0 };
  const client = msg.clients;
  if (!client?.ghl_location_id) return { proposed: 0, reason: "client has no GHL location" };

  // The thread's first message often names the patient the reply is about.
  let threadStart: string | null = null;
  const token = clientWorkspaceToken();
  if (msg.thread_ts && token) {
    const replies = await fetchThreadReplies(msg.channel, msg.thread_ts, { token, maxPages: 1 }).catch(() => []);
    const root = replies[0] as { text?: string } | undefined;
    threadStart = root?.text ? root.text.slice(0, 2000) : null;
  }
  const found = await extractOutcomes({ text: msg.text, threadStart, clientName: client.name }, { apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
  if (!found.length) return { proposed: 0 };
  const boss = await owner(db);
  if (!boss) return { proposed: 0, reason: "no owner with a Slack id" };

  let proposed = 0;
  for (const f of found) {
    const lookup = await dashboard<{ clinic?: { name: string; timezone: string }; candidates?: Candidate[]; error?: string }>("/api/agent/patients", { location_id: client.ghl_location_id, first: f.patient_first, last: f.patient_last });
    if (lookup.status !== 200 || !lookup.json.clinic) continue; // Not a clinic on the client dashboard.
    const candidates = lookup.json.candidates ?? [];
    const { data: row, error } = await db
      .from("outcome_proposals")
      .insert({ request_id: msg.id, client_id: msg.client_id, patient_first: f.patient_first, patient_last: f.patient_last, outcome: f.outcome, amount: f.amount, candidates })
      .select("id")
      .single();
    if (error) continue; // Already proposed for this message (a retry).
    const patient = [f.patient_first, f.patient_last].filter(Boolean).join(" ");
    const { text, blocks } = proposalBlocks({ id: row.id, clinic: lookup.json.clinic.name, message: msg.text, permalink: msg.permalink, patient, outcome: f.outcome, amount: f.amount, candidates, timezone: lookup.json.clinic.timezone });
    const sent = await postMessage(boss.slack_user_id, text, blocks);
    await db.from("outcome_proposals").update(sent.ok ? { dm_channel: sent.channel, dm_ts: sent.ts } : { error: `dm: ${sent.error}` }).eq("id", row.id);
    if (sent.ok) proposed++;
  }
  return { proposed };
}

type Payload = { user?: { id?: string }; actions?: { action_id?: string; value?: string }[]; response_url?: string; message?: { blocks?: { block_id?: string }[] } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Confirm / Ignore. Only the owner can press them; the outcome is logged on the client dashboard once. */
export async function decideOutcome(payload: Payload, db: SupabaseClient): Promise<void> {
  const action = payload.actions?.[0];
  const [id, contactId] = (action?.value ?? "").split(":");
  const say = async (text: string, replace: boolean) => {
    if (!payload.response_url) return;
    const original = payload.message?.blocks ?? [];
    const blocks = original.map((b) => (b.block_id === `act:outcome_proposals:${id}` ? { type: "context", elements: [{ type: "mrkdwn", text }] } : b));
    await respondToInteraction(payload.response_url, replace ? { replace_original: true, text, blocks } : { replace_original: false, response_type: "ephemeral", text }).catch(() => false);
  };
  if (!action || !UUID.test(id ?? "")) return say("That button is not something Genexa OS understands.", false);
  const boss = await owner(db);
  if (!boss || boss.slack_user_id !== payload.user?.id) return say("Only Aryan can confirm outcomes. Nothing was logged.", false);

  const confirm = action.action_id?.startsWith("outcome_confirm_") ?? false;
  // Claimed first, so a double click or a Slack retry logs once.
  const { data: claimed } = await db.from("outcome_proposals").update({ status: confirm ? "logging" : "ignored", decided_by: boss.name, decided_at: new Date().toISOString(), contact_id: confirm ? contactId : null }).eq("id", id).eq("status", "pending").select("id, outcome, amount, candidates, client_id, clients(ghl_location_id)").maybeSingle<{ id: string; outcome: "no_show" | "closed_won" | "not_closed"; amount: number | null; candidates: Candidate[]; clients: { ghl_location_id: string | null } | null }>();
  if (!claimed) return say("Already decided. Nothing more was done.", true);
  if (!confirm) return say(`🚫 Ignored by ${boss.name}. Nothing was logged.`, true);

  const candidate = claimed.candidates.find((c) => c.contact_id === contactId);
  if (!candidate || !claimed.clients?.ghl_location_id) {
    await db.from("outcome_proposals").update({ status: "failed", error: "patient not among the candidates" }).eq("id", id);
    return say("That patient was not one of the matches. Nothing was logged.", true);
  }
  const r = await dashboard<{ ok?: boolean; error?: string }>("/api/agent/outcome", {
    location_id: claimed.clients.ghl_location_id,
    contact_id: contactId,
    outcome: claimed.outcome,
    amount: claimed.amount,
    confirmed_by: boss.name,
  });
  if (r.json.ok) {
    await db.from("outcome_proposals").update({ status: "logged", error: null }).eq("id", id);
    return say(`✅ Logged by ${boss.name}: ${candidate.name} → ${outcomeText({ outcome: claimed.outcome, amount: claimed.amount ? Number(claimed.amount) : null })}, on the client dashboard and in GHL.`, true);
  }
  await db.from("outcome_proposals").update({ status: "failed", error: r.json.error ?? `HTTP ${r.status}` }).eq("id", id);
  return say(`⚠️ Could not log it: ${r.json.error ?? `the dashboard answered ${r.status}`}. Nothing was changed; log it on the dashboard instead.`, true);
}
