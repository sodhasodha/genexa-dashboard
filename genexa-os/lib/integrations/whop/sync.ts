// Whop sync: Genexa's own payments and memberships, straight from Whop.
// Writes payments, whop_memberships, clients.whop_customer_ids (new clear matches)
// and integration_sync_status. Nothing else.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WhopClient } from "./client";
import { customerName, mapMembership, mapPayment, matchWhopCustomer, type Catalog, type MatchClient } from "./mapper";

export type WhopSyncResult = {
  ok: boolean;
  payments: number;
  memberships: number;
  matched: { customer: string; client: string; reason: string }[];
  unmatched: { customer: string; email: string | null; paid: number }[];
  error: string | null;
};

export async function syncWhop(opts: { db: SupabaseClient; whop: WhopClient; since: string }): Promise<WhopSyncResult> {
  const { db, whop } = opts;
  const startedAt = new Date().toISOString();
  await db.from("integration_sync_status").update({ last_attempt_at: startedAt }).eq("source", "whop");
  const result: WhopSyncResult = { ok: false, payments: 0, memberships: 0, matched: [], unmatched: [], error: null };
  try {
    const [payments, memberships, plans, products, clientsRes, settings] = await Promise.all([
      whop.payments(), whop.memberships(), whop.plans(), whop.products(),
      db.from("clients").select("id, name, contact_name, kickoff_url, whop_customer_ids").is("deleted_at", null),
      db.from("app_settings").select("value").eq("key", "whop_excluded_products").maybeSingle(),
    ]);
    if (clientsRes.error) throw new Error(`clients: ${clientsRes.error.message}`);
    const clients = (clientsRes.data ?? []) as MatchClient[];
    const excluded = Array.isArray(settings.data?.value) ? (settings.data.value as string[]) : [];
    const catalog: Catalog = { plans: new Map(plans.map((p) => [p.id, p])), products: new Map(products.map((p) => [p.id, p])) };
    const emailByUser = new Map(memberships.filter((m) => m.user && m.email).map((m) => [m.user as string, m.email as string]));
    const sinceMs = new Date(`${opts.since}T00:00:00Z`).getTime();

    const rows = payments
      .filter((p) => (p.paid_at ?? p.created_at) * 1000 >= sinceMs)
      .map((p) => ({ raw: p, row: mapPayment(p, catalog, emailByUser, excluded) }))
      .filter((x): x is { raw: (typeof payments)[number]; row: NonNullable<ReturnType<typeof mapPayment>> } => x.row !== null);

    // One decision per Whop customer, from every name they have paid under.
    const users = new Map<string, { names: Set<string>; email: string | null; paid: number }>();
    for (const { raw, row } of rows) {
      if (!raw.user) continue;
      const u = users.get(raw.user) ?? { names: new Set<string>(), email: emailByUser.get(raw.user) ?? null, paid: 0 };
      const n = customerName(raw);
      if (n) u.names.add(n);
      if (row.status === "paid") u.paid += row.amount;
      users.set(raw.user, u);
    }
    const clientOf = new Map<string, string>();
    for (const [userId, u] of users) {
      const match = matchWhopCustomer({ user_id: userId, names: [...u.names], email: u.email }, clients);
      const label = [...u.names][0] ?? u.email ?? userId;
      if (!match) {
        result.unmatched.push({ customer: label, email: u.email, paid: Math.round(u.paid) });
        continue;
      }
      clientOf.set(userId, match.client_id);
      const client = clients.find((c) => c.id === match.client_id) as MatchClient;
      if (!client.whop_customer_ids.includes(userId)) {
        client.whop_customer_ids = [...client.whop_customer_ids, userId];
        const { error } = await db.from("clients").update({ whop_customer_ids: client.whop_customer_ids }).eq("id", client.id);
        if (error) throw new Error(`clients.whop_customer_ids: ${error.message}`);
        result.matched.push({ customer: label, client: client.name, reason: match.reason });
      }
    }

    const synced_at = new Date().toISOString();
    // Decisions a person made are kept: a payment or membership pinned to a client, and a label given to an untitled payment.
    const [pinned, pinnedMembers] = await Promise.all([
      db.from("payments").select("whop_payment_id, client_id, client_locked, title_override").or("client_locked.eq.true,title_override.not.is.null"),
      db.from("whop_memberships").select("whop_membership_id, client_id").eq("client_locked", true),
    ]);
    if (pinned.error) throw new Error(`payments: ${pinned.error.message}`);
    if (pinnedMembers.error) throw new Error(`whop_memberships: ${pinnedMembers.error.message}`);
    const pin = new Map((pinned.data ?? []).map((p) => [p.whop_payment_id as string, p]));
    const memberPin = new Map((pinnedMembers.data ?? []).map((m) => [m.whop_membership_id as string, m.client_id as string | null]));
    if (rows.length > 0) {
      const { error } = await db.from("payments").upsert(
        rows.map(({ row }) => {
          const kept = pin.get(row.whop_payment_id);
          return {
            ...row,
            product_title: row.product_title ?? kept?.title_override ?? null,
            client_id: kept?.client_locked ? kept.client_id : (row.whop_user_id && clientOf.get(row.whop_user_id)) || null,
            synced_at,
          };
        }),
        { onConflict: "whop_payment_id" },
      );
      if (error) throw new Error(`payments: ${error.message}`);
    }
    const memberRows = memberships.map((m) => ({
      ...mapMembership(m, catalog),
      client_id: memberPin.has(m.id) ? (memberPin.get(m.id) ?? null) : (m.user && clientOf.get(m.user)) || null,
      synced_at,
    }));
    const kept = memberRows.filter((m) => !(m.product_title && excluded.some((x) => x.toLowerCase() === (m.product_title as string).toLowerCase())));
    if (kept.length > 0) {
      const { error } = await db.from("whop_memberships").upsert(kept, { onConflict: "whop_membership_id" });
      if (error) throw new Error(`whop_memberships: ${error.message}`);
    }
    result.payments = rows.length;
    result.memberships = kept.length;
    result.ok = true;
  } catch (err) {
    result.error = (err as Error).message;
  }
  const finishedAt = new Date().toISOString();
  await db.from("integration_sync_status").update({
    status: result.ok ? "ok" : "error", rows_processed: result.payments + result.memberships, error: result.error,
    ...(result.ok ? { last_success_at: finishedAt } : {}),
  }).eq("source", "whop");
  await db.from("job_runs").insert({ job: "whop-sync", started_at: startedAt, finished_at: finishedAt, ok: result.ok, rows_processed: result.payments + result.memberships, error: result.error });
  return result;
}
