import "server-only";
import { createClient } from "@/lib/supabase/server";

// Typed reads of renewal_plans and renewal_clients (0075_renewal_plans.sql). Subscriptions are kept
// by hand on /renewals, never synced from Whop. Every figure is computed in SQL except ROAS
// (revenue / spend). Owner only: under RLS anyone else gets no rows.

export type RenewalStatus = "active" | "past_due" | "cancelling" | "ended";
export type RenewalWindow = "cycle" | "launch";

export type RenewalPlan = {
  id: string;
  client_id: string;
  name: string;
  every_days: number;
  amount: number;
  next_due: string;
  status: RenewalStatus;
  note: string | null;
};

export type RenewalClient = {
  client_id: string;
  client: string;
  stage: string;
  next_due: string | null;
  ads_unverified: boolean;
  no_cortana: boolean;
  spend: number | null;
  revenue: number | null;
  profit: number | null;
  roas: number | null;
  plans: RenewalPlan[];
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Clients soonest due first (nothing running last), each with its subscriptions soonest due first. */
export async function getRenewals(window: RenewalWindow): Promise<RenewalClient[]> {
  const supabase = await createClient();
  const [clients, plans] = await Promise.all([
    supabase.from("renewal_clients").select("*"),
    supabase.from("renewal_plans").select("id, client_id, name, every_days, amount, next_due, status, note").is("archived_at", null).order("next_due"),
  ]);
  if (clients.error) throw new Error(`renewal_clients: ${clients.error.message}`);
  if (plans.error) throw new Error(`renewal_plans: ${plans.error.message}`);
  const byClient = new Map<string, RenewalPlan[]>();
  for (const p of plans.data ?? []) byClient.set(p.client_id, [...(byClient.get(p.client_id) ?? []), { ...p, amount: Number(p.amount) } as RenewalPlan]);
  const due = (d: string | null) => d ?? "9999-12-31";
  return (clients.data ?? [])
    .map((c) => {
      const spend = num(window === "cycle" ? c.cycle_spend : c.launch_spend);
      const revenue = num(window === "cycle" ? c.cycle_revenue : c.launch_revenue);
      return {
        client_id: c.client_id, client: c.client, stage: c.stage, next_due: c.next_due, ads_unverified: c.ads_unverified, no_cortana: c.no_cortana,
        spend, revenue, profit: num(window === "cycle" ? c.cycle_profit : c.launch_profit),
        roas: spend && revenue !== null ? revenue / spend : null,
        plans: byClient.get(c.client_id) ?? [],
      };
    })
    .sort((a, b) => due(a.next_due).localeCompare(due(b.next_due)) || a.client.localeCompare(b.client));
}

/** Clients a subscription can belong to. */
export async function getClientChoices(): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("clients").select("id, name").is("deleted_at", null).neq("stage", "churned").order("name");
  return data ?? [];
}
