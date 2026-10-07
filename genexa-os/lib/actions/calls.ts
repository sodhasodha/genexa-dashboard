"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/staff";
import { callPerson } from "@/lib/integrations/fathom/person";
import { createClient } from "@/lib/supabase/server";

const Id = z.uuid();
const Target = z.string().regex(/^(prospect|client):[0-9a-f-]{36}$/i);

/**
 * The owner says who an unmatched Fathom call was with: an existing prospect or
 * client, a new prospect, or nobody worth tracking. The answer is kept: the
 * sync never changes a call a person has resolved.
 */
export async function resolveCall(formData: FormData) {
  const me = await requireOwner();
  const id = Id.safeParse(formData.get("id"));
  const decision = String(formData.get("decision"));
  if (!id.success) return;
  const supabase = await createClient();
  const { data: call } = await supabase.from("fathom_calls").select("id, recording_id, title, started_at, share_url, url, external_names").eq("id", id.data).single();
  if (!call) return;
  const link = (call.share_url ?? call.url) as string | null;
  const day = String(call.started_at).slice(0, 10);

  if (decision === "ignore") {
    await supabase.from("fathom_calls").update({ kind: "ignored", resolved_by: me.id, match_reason: "ignored by the owner" }).eq("id", call.id);
  } else if (decision === "new_prospect") {
    const person = callPerson(call.title as string | null, (call.external_names as string[]) ?? []);
    if (!person) return;
    const { data: created } = await supabase.from("prospects").insert({ name: person, stage: "chase", call_date: day, fathom_url: link }).select("id").single();
    if (!created) return;
    await supabase.from("fathom_calls").update({ kind: "prospect", prospect_id: created.id, resolved_by: me.id, match_reason: "new prospect created by the owner" }).eq("id", call.id);
  } else if (decision === "assign") {
    const target = Target.safeParse(formData.get("target"));
    if (!target.success) return;
    const [type, targetId] = target.data.split(":");
    if (type === "prospect") {
      const { data: p } = await supabase.from("prospects").select("call_date, fathom_url").eq("id", targetId).single();
      const patch: Record<string, string> = {};
      if (p && !p.fathom_url && link) patch.fathom_url = link;
      if (p && !p.call_date) patch.call_date = day;
      if (Object.keys(patch).length > 0) await supabase.from("prospects").update(patch).eq("id", targetId);
      await supabase.from("fathom_calls").update({ kind: "prospect", prospect_id: targetId, client_id: null, resolved_by: me.id, match_reason: "assigned by the owner" }).eq("id", call.id);
    } else {
      const ref = `fathom:${call.recording_id}`;
      const { data: has } = await supabase.from("touches").select("id").eq("external_ref", ref).maybeSingle();
      if (!has) await supabase.from("touches").insert({ client_id: targetId, at: call.started_at, kind: "call", external_ref: ref, by_id: me.id, note: `${call.title ?? "Call"} (Fathom) ${link ?? ""}`.trim() });
      await supabase.from("fathom_calls").update({ kind: "client", client_id: targetId, prospect_id: null, resolved_by: me.id, match_reason: "assigned by the owner" }).eq("id", call.id);
    }
  }
  revalidatePath("/overview");
  revalidatePath("/data-review");
}
