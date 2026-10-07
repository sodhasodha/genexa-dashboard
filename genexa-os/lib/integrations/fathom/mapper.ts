// Typed mapper for Fathom's /external/v1/meetings. Pure. Field names from a real response.
// Only names and email domains are kept; email addresses are used for matching and dropped.
import { z } from "zod";
import { matchWhopCustomer, type MatchClient } from "@/lib/integrations/whop/mapper";

const Invitee = z.object({ name: z.string().nullable().optional(), email: z.string().nullable().optional(), email_domain: z.string().nullable().optional(), is_external: z.boolean().nullable().optional() }).loose();
export const FathomMeeting = z
  .object({
    recording_id: z.union([z.number(), z.string()]),
    title: z.string().nullable().optional(),
    meeting_title: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    share_url: z.string().nullable().optional(),
    created_at: z.string(),
    recording_start_time: z.string().nullable().optional(),
    scheduled_start_time: z.string().nullable().optional(),
    calendar_invitees: z.array(Invitee).nullable().optional(),
    recorded_by: z.object({ email: z.string().nullable().optional() }).loose().nullable().optional(),
  })
  .loose();
export type FathomMeeting = z.infer<typeof FathomMeeting>;
export const FathomMeetingsResponse = z.object({ items: z.array(FathomMeeting), next_cursor: z.string().nullable().optional() }).loose();

export type FathomContext = {
  clients: (MatchClient & { emails: string[] })[];
  prospects: { id: string; name: string }[];
  staffEmails: string[];
};

export type CallRow = {
  recording_id: string;
  title: string | null;
  started_at: string;
  url: string | null;
  share_url: string | null;
  external_names: string[];
  external_domains: string[];
  kind: "client" | "prospect" | "internal" | "unmatched";
  client_id: string | null;
  prospect_id: string | null;
  match_reason: string | null;
  recorded_by_email: string | null;
};

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w !== "" && !["dr", "md", "do", "the", "x"].includes(w));

/**
 * Who was this call with?
 *  client   = an outside invitee is a client's known email, contact name or clinic email domain.
 *  prospect = an outside invitee's full name is an existing prospect's name (prospects are never created here).
 *  internal = nobody from outside Genexa was invited (staff with personal emails count as inside).
 *  unmatched = someone outside, but not a client or a known prospect.
 */
export function mapMeeting(m: FathomMeeting, ctx: FathomContext): CallRow {
  const staff = new Set(ctx.staffEmails.map((e) => e.toLowerCase()));
  const invitees = (m.calendar_invitees ?? []).filter((i) => i.is_external && !(i.email && staff.has(i.email.toLowerCase())));
  const base = {
    recording_id: String(m.recording_id),
    title: m.title ?? m.meeting_title ?? null,
    started_at: m.recording_start_time ?? m.scheduled_start_time ?? m.created_at,
    url: m.url ?? null,
    share_url: m.share_url ?? null,
    external_names: invitees.map((i) => i.name?.trim()).filter((n): n is string => !!n),
    external_domains: [...new Set(invitees.map((i) => i.email_domain ?? i.email?.split("@")[1]).filter((d): d is string => !!d))],
    recorded_by_email: m.recorded_by?.email?.toLowerCase() ?? null,
  };
  // Many calls are booked with nobody else on the invite; the person is then only in the title
  // ("Genexa Scaling x Joshua Hare", "Matt Marcotte - Follow Up").
  const titled = (base.title ?? "").replace(/^genexa scaling\s*x\s*/i, "").replace(/\s*-\s*(onboarding call|follow up|patient generation call)\s*$/i, "").trim();
  const fromTitle = (): CallRow | null => {
    if (titled.split(/\s+/).length < 2 || titled.toLowerCase() === (base.title ?? "").toLowerCase()) return null;
    const c = matchWhopCustomer({ user_id: null, names: [titled], email: null }, ctx.clients);
    if (c) return { ...base, kind: "client", client_id: c.client_id, prospect_id: null, match_reason: `name in the call title (${c.reason})` };
    const w = words(titled);
    const hits = ctx.prospects.filter((p) => { const pw = new Set(words(p.name)); return w.length >= 2 && w.every((x) => pw.has(x)); });
    if (hits.length === 1) return { ...base, kind: "prospect", client_id: null, prospect_id: hits[0].id, match_reason: `name in the call title (prospect "${hits[0].name}")` };
    return null;
  };
  if (invitees.length === 0) return fromTitle() ?? { ...base, kind: "internal", client_id: null, prospect_id: null, match_reason: null };

  for (const i of invitees) {
    const email = i.email?.toLowerCase() ?? null;
    const byEmail = email ? ctx.clients.filter((c) => c.emails.includes(email)) : [];
    if (byEmail.length === 1) return { ...base, kind: "client", client_id: byEmail[0].id, prospect_id: null, match_reason: "a known email for this client" };
    const match = matchWhopCustomer({ user_id: null, names: i.name ? [i.name] : [], email }, ctx.clients);
    if (match) return { ...base, kind: "client", client_id: match.client_id, prospect_id: null, match_reason: match.reason };
  }
  for (const i of invitees) {
    const w = words(i.name ?? "");
    if (w.length < 2) continue;
    const hits = ctx.prospects.filter((p) => { const pw = new Set(words(p.name)); return w.every((x) => pw.has(x)); });
    if (hits.length === 1) return { ...base, kind: "prospect", client_id: null, prospect_id: hits[0].id, match_reason: `prospect "${hits[0].name}"` };
  }
  return fromTitle() ?? { ...base, kind: "unmatched", client_id: null, prospect_id: null, match_reason: null };
}
