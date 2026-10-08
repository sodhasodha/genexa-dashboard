import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appUrl } from "@/lib/env";
import { postMessage } from "@/lib/slack/client";

const RULE = "new_client";
type Send = (slackUserId: string, text: string) => Promise<{ ok: boolean; ts?: string; channel?: string; error?: string }>;

/** The DM the owner gets. The name is the Whop customer's, which is a clinic contact, not a patient. */
export const newClientText = (name: string, amount: number, url: string) =>
  `New client: ${name}, $${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}\nCreated in Onboarding with a launch at Paid: ${url}`;

/**
 * After a Whop sync: turn brand-new paying customers into clients (see
 * whop_create_new_clients) and DM the owner once per client. A DM that fails is
 * retried on the next run; the client is never created twice.
 */
export async function createNewClientsFromWhop(opts: { db: SupabaseClient; send?: Send }): Promise<{ created: string[]; dm_sent: number; dm_failed: string[] }> {
  const { db } = opts;
  const send: Send = opts.send ?? ((user, text) => postMessage(user, text));
  const out = { created: [] as string[], dm_sent: 0, dm_failed: [] as string[] };
  const made = await db.rpc("whop_create_new_clients");
  if (made.error) throw new Error(`whop_create_new_clients: ${made.error.message}`);
  const rows = (made.data ?? []) as { client_id: string; name: string; amount: number; paid_at: string }[];
  out.created = rows.map((r) => r.name);

  const holder = await db.rpc("app_role_holder", { p_role: "owner" });
  const ownerId = holder.data as string | null;
  if (!ownerId) return out;
  const { data: owner } = await db.from("staff").select("slack_user_id").eq("id", ownerId).maybeSingle();
  for (const r of rows) {
    await db.from("notifications").insert({ rule_key: RULE, staff_id: ownerId, record_type: "clients", record_id: r.client_id, payload: { name: r.name, amount: Number(r.amount) } });
  }
  // Every new-client DM not sent yet, including ones a previous run could not deliver.
  const { data: pending } = await db.from("notifications").select("id, record_id, payload").eq("rule_key", RULE).eq("staff_id", ownerId).is("sent_at", null);
  for (const n of pending ?? []) {
    const p = (n.payload ?? {}) as { name?: string; amount?: number };
    if (!owner?.slack_user_id) { out.dm_failed.push(`${p.name}: the owner has no Slack id`); continue; }
    const r = await send(owner.slack_user_id as string, newClientText(p.name ?? "New client", Number(p.amount ?? 0), `${appUrl()}/clients/${n.record_id}`));
    if (!r.ok) { out.dm_failed.push(`${p.name}: ${r.error ?? "error"}`); continue; }
    await db.from("notifications").update({ sent_at: new Date().toISOString(), slack_ts: r.ts ?? "sent", channel: r.channel ?? null }).eq("id", n.id);
    out.dm_sent++;
  }
  return out;
}
