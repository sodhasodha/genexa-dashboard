"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/staff";
import { localToInstant } from "@/lib/deadlines";
import { createClient } from "@/lib/supabase/server";
import { afterRouting, type RouteResult } from "@/lib/router/process";
import { processDeps } from "@/lib/router/runtime";

const Id = z.uuid();
const Decision = z.enum(["assign", "approve", "not_request", "reject"]);
const Owner = z.enum(["tech", "ads", "ryan"]);

const done = () => {
  revalidatePath("/overview");
  revalidatePath("/data-review");
  revalidatePath("/router");
};

/**
 * The owner's buttons on a client request: Triage (Assign -> Tech / Ads / Ryan,
 * Not a request) and backfill (Approve, Reject). What each one does is decided
 * in SQL (router_decide -> route_client_request).
 */
export async function decideClientRequest(formData: FormData) {
  await requireOwner();
  const id = Id.parse(formData.get("id"));
  // An owner button (Tech / Ads / Ryan) means "assign"; the other buttons name their decision.
  const action = Decision.parse(formData.get("decision") ?? (formData.get("owner") ? "assign" : null));
  const owner = action === "assign" ? Owner.parse(formData.get("owner")) : null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("router_decide", { p_id: id, p_action: action, p_owner: owner });
  if (error) throw new Error(`router_decide: ${error.message}`);
  // An urgent request for Ryan DMs him now; a live request that is now routed gets its thread reply (if replies are on).
  if (data) await afterRouting(data as RouteResult, processDeps());
  done();
}

/**
 * The owner's deadline for a request still in Triage or awaiting approval, typed in UK
 * time (converted here, on the server). The "default" button clears it, so the request
 * goes back to the client's own deadline or the end of the person's next shift.
 * The work created on Assign / Approve carries it (route_client_request).
 */
export async function setRequestDeadline(formData: FormData) {
  await requireOwner();
  const id = Id.parse(formData.get("id"));
  let dueAt: string | null = null;
  if (formData.get("default") === null) {
    const at = localToInstant(String(formData.get("due_at_uk") ?? ""));
    if (!at) throw new Error("The deadline must be a date and a time.");
    dueAt = at.toISOString();
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("router_set_deadline", { p_id: id, p_due_at: dueAt });
  if (error) throw new Error(`router_set_deadline: ${error.message}`);
  done();
}

/** Was the model right about this message? */
export async function setRouterVerdict(formData: FormData) {
  await requireOwner();
  const id = Id.parse(formData.get("id"));
  const verdict = z.enum(["right", "wrong"]).parse(formData.get("verdict"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("router_set_verdict", { p_id: id, p_verdict: verdict });
  if (error) throw new Error(`router_set_verdict: ${error.message}`);
  revalidatePath("/router");
}
