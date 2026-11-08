import "server-only";
import { createClient } from "@/lib/supabase/server";

// Typed reads of renewal_subscriptions and renewal_clients (0074_renewals.sql). Every figure is
// computed in SQL except ROAS (revenue / spend). Owner only: edits are under RLS.

export type RenewalState = "active" | "past_due" | "cancelling" | "ended";
export type RenewalWindow = "cycle" | "launch";

export type RenewalSub = {
  membership_id: string;
  client_id: string;
  product_title: string | null;
  state: RenewalState;
  every_days: number;
  amount: number | null;
  next_due: string | null;
  whop_days: number | null;
  whop_amount: number | null;
  whop_due: string | null;
  edit_days: number | null;
  edit_amount: number | null;
  edit_due: string | null;
  edit_due_expired: boolean;
  note: string | null;
};

export type RenewalClient = {
  client_id: string;
  client: string;
  stage: string;
  next_due: string | null;
  cycle_start: string | null;
  launch_date: string | null;
  ads_unverified: boolean;
  no_cortana: boolean;
  spend: number | null;
  revenue: number | null;
  profit: number | null;
  roas: number | null;
  subs: RenewalSub[];
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Clients soonest due first (no running subscription last), each with its subscriptions soonest due first. */
export async function getRenewals(window: RenewalWindow, showEnded: boolean): Promise<RenewalClient[]> {
  const supabase = await createClient();
  const [clients, subs] = await Promise.all([
    supabase.from("renewal_clients_all").select("*"),
    supabase.from("renewal_subscriptions").select("membership_id, client_id, product_title, state, every_days, amount, next_due, whop_days, whop_amount, whop_due, edit_days, edit_amount, edit_due, edit_due_expired, note"),
  ]);
  if (clients.error) throw new Error(`renewal_clients_all: ${clients.error.message}`);
  if (subs.error) throw new Error(`renewal_subscriptions: ${subs.error.message}`);
  const byClient = new Map<string, RenewalSub[]>();
  for (const s of subs.data ?? []) {
    if (s.state === "ended" && !showEnded) continue;
    const row: RenewalSub = { ...s, amount: num(s.amount), whop_amount: num(s.whop_amount), edit_amount: num(s.edit_amount) } as RenewalSub;
    byClient.set(s.client_id, [...(byClient.get(s.client_id) ?? []), row]);
  }
  const due = (d: string | null) => d ?? "9999-12-31";
  return (clients.data ?? [])
    .filter((c) => byClient.has(c.client_id))
    .map((c) => {
      const spend = num(window === "cycle" ? c.cycle_spend : c.launch_spend);
      const revenue = num(window === "cycle" ? c.cycle_revenue : c.launch_revenue);
      return {
        client_id: c.client_id, client: c.client, stage: c.stage, next_due: c.next_due, cycle_start: c.cycle_start, launch_date: c.launch_date,
        ads_unverified: c.ads_unverified, no_cortana: c.no_cortana, spend, revenue,
        profit: num(window === "cycle" ? c.cycle_profit : c.launch_profit),
        roas: spend && revenue !== null ? revenue / spend : null,
        subs: (byClient.get(c.client_id) ?? []).sort((a, b) => due(a.next_due).localeCompare(due(b.next_due))),
      };
    })
    .sort((a, b) => due(a.next_due).localeCompare(due(b.next_due)) || a.client.localeCompare(b.client));
}

/** Clients a subscription can be moved to. */
export async function getClientChoices(): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("clients").select("id, name").is("deleted_at", null).neq("stage", "churned").order("name");
  return data ?? [];
}
