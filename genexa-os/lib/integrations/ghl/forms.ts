// Genexa's own GHL sub-account ("GXS Client Success"): the New Client Form and the
// Onboarding Form surveys. Read only. Only the clinic name, the contact's name,
// the submission time and (for matching, never stored) the email leave this file.
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

const BASE = "https://services.leadconnectorhq.com";

export const GhlSurveysResponse = z.object({ surveys: z.array(z.object({ id: z.string(), name: z.string() }).loose()) }).loose();
export const GhlSubmission = z
  .object({
    id: z.string(),
    contactId: z.string().nullable().optional(),
    surveyId: z.string(),
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    createdAt: z.string(),
    others: z.object({ organization: z.string().nullable().optional(), full_name: z.string().nullable().optional() }).loose().nullable().optional(),
  })
  .loose();
export const GhlSubmissionsResponse = z
  .object({ submissions: z.array(GhlSubmission), meta: z.object({ nextPage: z.number().nullable().optional() }).loose().nullable().optional() })
  .loose();

export type FormKind = "new_client" | "onboarding";
export type FormSubmission = { id: string; kind: FormKind; contactId: string | null; organization: string; contact: string | null; email: string | null; at: string };

/** Which survey is which, by its name in GHL. The Kick Off Form and anything else is ignored. */
export function formKind(surveyName: string): FormKind | null {
  if (/new\s*client/i.test(surveyName)) return "new_client";
  if (/onboarding/i.test(surveyName)) return "onboarding";
  return null;
}

export function mapSubmissions(raw: unknown, kinds: Map<string, FormKind>): FormSubmission[] {
  return GhlSubmissionsResponse.parse(raw).submissions.flatMap((s) => {
    const kind = kinds.get(s.surveyId);
    if (!kind) return [];
    return [{
      id: s.id, kind, contactId: s.contactId ?? null,
      organization: (s.others?.organization ?? "").trim(),
      contact: (s.others?.full_name ?? s.name ?? "").trim() || null,
      email: s.email?.trim().toLowerCase() || null,
      at: new Date(s.createdAt).toISOString(),
    }];
  });
}

const FILLER = new Set(["llc", "inc", "pllc", "pc", "the", "and", "of", "clinic", "center", "centre", "medical", "health", "wellness", "md"]);
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const squash = (s: string) => fold(s).replace(/[^a-z0-9]/g, "");
const words = (s: string) => fold(s).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !FILLER.has(w));

export type FormClient = { id: string; name: string };

/**
 * The client a clinic name on a form means, or null when it is not clear.
 * Exact name; the same letters ("Airsclinic" = "Airs Clinic"); the same words in
 * any order ("icp cleveland" = "cleveland icp"); or every distinctive word of one
 * inside the other, when exactly one client fits ("Vitale health").
 */
export function matchClinicName(organization: string, clients: FormClient[]): string | null {
  const org = organization.trim();
  if (!org) return null;
  const exact = clients.filter((c) => fold(c.name).trim() === fold(org));
  if (exact.length === 1) return exact[0].id;
  const same = clients.filter((c) => squash(c.name) === squash(org));
  if (same.length === 1) return same[0].id;
  const ow = words(org);
  if (ow.length === 0) return null;
  const bag = clients.filter((c) => { const cw = words(c.name); return cw.length === ow.length && cw.every((w) => ow.includes(w)); });
  if (bag.length === 1) return bag[0].id;
  const inside = clients.filter((c) => {
    const cw = words(c.name);
    // One short shared word ("Regen") is not enough to pick a clinic.
    const strong = (set: string[]) => set.length >= 2 || (set.length === 1 && set[0].length >= 6);
    return (strong(cw) && cw.every((w) => ow.includes(w))) || (strong(ow) && ow.every((w) => cw.includes(w)));
  });
  return inside.length === 1 ? inside[0].id : null;
}

export type FormDecision = { submission: FormSubmission; clientId: string | null; reason: string };

/**
 * Where each submission goes. New Client Forms first (oldest first), so an
 * Onboarding Form filled by the same GHL contact lands on the same client even
 * when the clinic typed its name differently.
 */
export function decideForms(subs: FormSubmission[], clients: FormClient[], byWhopEmail: Map<string, string> = new Map()): FormDecision[] {
  const byContact = new Map<string, string>();
  const ordered = [...subs].sort((a, b) => (a.kind === b.kind ? a.at.localeCompare(b.at) : a.kind === "new_client" ? -1 : 1));
  return ordered.map((s) => {
    if (s.kind === "new_client") {
      const named = matchClinicName(s.organization, clients);
      // No such clinic name yet, but this person has already paid on Whop: that client, not a second one.
      const paid = !named && s.email ? (byWhopEmail.get(s.email) ?? null) : null;
      const id = named ?? paid;
      if (s.contactId) byContact.set(s.contactId, id ?? `new:${s.organization}`);
      return { submission: s, clientId: id, reason: named ? "clinic name" : paid ? "same email as a Whop customer" : "no client with this name" };
    }
    const linked = s.contactId ? byContact.get(s.contactId) : undefined;
    if (linked && !linked.startsWith("new:")) return { submission: s, clientId: linked, reason: "same GHL contact as the New Client Form" };
    const viaName = matchClinicName(linked?.startsWith("new:") ? linked.slice(4) : s.organization, clients) ?? matchClinicName(s.organization, clients);
    return { submission: s, clientId: viaName, reason: viaName ? "clinic name" : "no client matched" };
  });
}

export type GhlFormsResult = { ok: boolean; read: number; matched: number; created: string[]; already: number; unmatched: string[]; error: string | null };

export async function syncGhlForms(opts: { db: SupabaseClient; locationId: string; apiKey: string; fetchImpl?: typeof fetch }): Promise<GhlFormsResult> {
  const { db } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const result: GhlFormsResult = { ok: false, read: 0, matched: 0, created: [], already: 0, unmatched: [], error: null };
  const get = async (path: string): Promise<unknown> => {
    const res = await doFetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${opts.apiKey}`, Version: "2021-07-28", Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) throw new Error(`GHL ${res.status} on ${path.split("?")[0]}`);
    return res.json();
  };
  try {
    const surveys = GhlSurveysResponse.parse(await get(`/surveys/?locationId=${opts.locationId}&limit=50`)).surveys;
    const kinds = new Map<string, FormKind>();
    for (const s of surveys) { const k = formKind(s.name); if (k) kinds.set(s.id, k); }
    const subs: FormSubmission[] = [];
    for (let page = 1; page <= 20; page++) {
      const raw = await get(`/surveys/submissions?locationId=${opts.locationId}&limit=100&page=${page}`);
      subs.push(...mapSubmissions(raw, kinds));
      if (!GhlSubmissionsResponse.parse(raw).meta?.nextPage) break;
    }
    result.read = subs.length;
    const load = async () => {
      const { data, error } = await db.from("clients").select("id, name").is("deleted_at", null);
      if (error) throw new Error(`clients: ${error.message}`);
      return (data ?? []) as FormClient[];
    };
    // Two passes: a client created from a New Client Form in the first is there for its Onboarding Form in the second.
    // Clients the Whop sync created (named after the payer), by the payer's email.
    const { data: paid } = await db.from("payments").select("customer_email, client:clients!inner(id, name, contact_name, stage)").not("customer_email", "is", null).not("client_id", "is", null);
    const byWhopEmail = new Map<string, string>();
    for (const p of (paid ?? []) as unknown as { customer_email: string; client: { id: string; name: string; contact_name: string | null; stage: string } }[]) {
      if (p.client.stage === "onboarding" && p.client.name === p.client.contact_name) byWhopEmail.set(p.customer_email.toLowerCase(), p.client.id);
    }
    for (const kind of ["new_client", "onboarding"] as const) {
      const decisions = decideForms(subs, await load(), byWhopEmail).filter((d) => d.submission.kind === kind);
      for (const d of decisions) {
        const { data, error } = await db.rpc("ghl_form_intake", {
          p_submission_id: d.submission.id, p_kind: kind, p_client_id: d.clientId, p_org: d.submission.organization, p_contact: d.submission.contact, p_at: d.submission.at, p_email: d.submission.email,
        });
        if (error) throw new Error(`ghl_form_intake: ${error.message}`);
        const r = (data as { result: string }).result;
        if (r === "already_taken") result.already++;
        else if (r === "client_created") result.created.push(d.submission.organization);
        else if (r === "matched") result.matched++;
        else result.unmatched.push(`${d.submission.organization || "(no clinic name)"} (${kind === "onboarding" ? "Onboarding Form" : "New Client Form"}, ${d.submission.at.slice(0, 10)})`);
      }
    }
    result.ok = true;
  } catch (err) {
    result.error = (err as Error).message;
  }
  return result;
}
