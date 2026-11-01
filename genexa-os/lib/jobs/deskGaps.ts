import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appUrl } from "@/lib/env";
import { postMessage } from "@/lib/slack/client";
import type { DeskGap } from "@/lib/integrations/ghl/confirmations";

const RULE = "desk_not_connected";
type Send = (slackUserId: string, text: string) => Promise<{ ok: boolean; ts?: string; channel?: string; error?: string }>;

export const deskGapText = (name: string, reason: string, url: string) =>
  `${name} is live but its appointments cannot reach the Confirmations desk: ${reason}.\n${url}`;

/** DM the owner once per clinic (the unique index on notifications refuses a repeat). A DM that fails is retried on the next run. */
export async function alertDeskGaps(opts: { db: SupabaseClient; gaps: DeskGap[]; send?: Send }): Promise<{ dm_sent: number; dm_failed: string[] }> {
  const { db, gaps } = opts;
  const send: Send = opts.send ?? ((user, text) => postMessage(user, text));
  const out = { dm_sent: 0, dm_failed: [] as string[] };
  const holder = await db.rpc("app_role_holder", { p_role: "owner" });
  const ownerId = holder.data as string | null;
  if (!ownerId) return out;
  const { data: owner } = await db.from("staff").select("slack_user_id").eq("id", ownerId).maybeSingle();
  for (const g of gaps) {
    await db.from("notifications").insert({ rule_key: RULE, staff_id: ownerId, record_type: "clients", record_id: g.client_id, payload: { name: g.name, reason: g.reason } });
  }
  const { data: pending } = await db.from("notifications").select("id, record_id, payload").eq("rule_key", RULE).eq("staff_id", ownerId).is("sent_at", null);
  for (const n of pending ?? []) {
    const p = (n.payload ?? {}) as { name?: string; reason?: string };
    if (!owner?.slack_user_id) { out.dm_failed.push(`${p.name}: the owner has no Slack id`); continue; }
    const r = await send(owner.slack_user_id as string, deskGapText(p.name ?? "A clinic", p.reason ?? "not connected", `${appUrl()}/clients/${n.record_id}`));
    if (!r.ok) { out.dm_failed.push(`${p.name}: ${r.error ?? "error"}`); continue; }
    await db.from("notifications").update({ sent_at: new Date().toISOString(), slack_ts: r.ts ?? "sent", channel: r.channel ?? null }).eq("id", n.id);
    out.dm_sent++;
  }
  return out;
}
