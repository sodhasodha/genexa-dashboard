// The Hot Leads sync, every 2 minutes. Read only: it reads each clinic's GHL
// conversations, latest texts in, calendars and contact tags, and never changes GHL.
// Who is hot, and why, is decided in lib/hotLeads/rules.ts.
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isCancelled } from "./confirmations";
import { CALLBACK_KEYWORDS, CALLBACK_TAGS, HIDE_TAGS, RESCHEDULE_KEYWORDS, WINDOWS } from "@/lib/hotLeads/config";
import { decideLead, findKeyword, hasTag, type HotReason, type Lead } from "@/lib/hotLeads/rules";

const BASE = "https://services.leadconnectorhq.com";
const HOUR = 3_600_000;
/** Contact name and tags read from GHL are reused this long (only for leads with no recent conversation). */
const CONTACT_FRESH_MS = 30 * 60_000;
/** Appointments this far ahead count as upcoming. */
const AHEAD_DAYS = 365;

const Conversation = z.object({
  id: z.string(), contactId: z.string().nullable().optional(), lastMessageDate: z.number().nullable().optional(),
  fullName: z.string().nullable().optional(), contactName: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(), sort: z.array(z.unknown()).nullable().optional(),
}).loose();
const Conversations = z.object({ conversations: z.array(Conversation) }).loose();
const Message = z.object({ direction: z.string().nullable().optional(), messageType: z.string().nullable().optional(), body: z.string().nullable().optional(), dateAdded: z.string() }).loose();
const Messages = z.object({ messages: z.object({ messages: z.array(Message) }).loose() }).loose();
const Calendars = z.object({ calendars: z.array(z.object({ id: z.string(), name: z.string() }).loose()) }).loose();
const Event = z.object({
  id: z.string(), contactId: z.string().nullable().optional(), startTime: z.string(), dateUpdated: z.string().nullable().optional(),
  appointmentStatus: z.string().nullable().optional(), deleted: z.boolean().nullable().optional(),
}).loose();
const Events = z.object({ events: z.array(Event) }).loose();
const Contact = z.object({
  contact: z.object({ firstName: z.string().nullable().optional(), lastName: z.string().nullable().optional(), tags: z.array(z.string()).nullable().optional(), dnd: z.boolean().nullable().optional() }).loose(),
}).loose();

const SMS_TYPES = new Set(["TYPE_SMS", "TYPE_CUSTOM_SMS"]);

/** A patient's latest text in, from a conversation's messages (pure). */
export function latestInboundSms(messages: z.infer<typeof Message>[]): { at: number; reschedule: boolean; callback: boolean } | null {
  let best: z.infer<typeof Message> | null = null;
  for (const m of messages) {
    if (m.direction !== "inbound" || !SMS_TYPES.has(m.messageType ?? "")) continue;
    if (!best || Date.parse(m.dateAdded) > Date.parse(best.dateAdded)) best = m;
  }
  if (!best) return null;
  const body = best.body ?? "";
  return { at: Date.parse(best.dateAdded), reschedule: findKeyword(body, RESCHEDULE_KEYWORDS) !== null, callback: findKeyword(body, CALLBACK_KEYWORDS) !== null };
}

/** Per contact, from every calendar's appointments (pure): who has one to come, their latest cancellation and no-show. */
export function appointmentFacts(events: z.infer<typeof Event>[], now: number) {
  const upcoming = new Set<string>();
  const cancelledAt = new Map<string, number>();
  const noShowAt = new Map<string, number>();
  const later = (m: Map<string, number>, k: string, t: number) => { if (Number.isFinite(t) && t > (m.get(k) ?? -Infinity)) m.set(k, t); };
  for (const e of events) {
    if (!e.contactId) continue;
    const start = Date.parse(e.startTime);
    const status = e.appointmentStatus ?? "";
    if (start > now && !isCancelled(e)) upcoming.add(e.contactId);
    else if (/no_?show/i.test(status) && start <= now) later(noShowAt, e.contactId, start);
    else if (/cancel/i.test(status)) later(cancelledAt, e.contactId, Date.parse(e.dateUpdated ?? e.startTime));
  }
  return { upcoming, cancelledAt, noShowAt };
}

type Cached = {
  ghl_contact_id: string; name: string | null; tags: string[]; contact_read_at: string | null; messages_read_for: string | null;
  last_inbound_sms_at: string | null; inbound_reschedule: boolean; inbound_callback: boolean;
};
type ConvSummary = { ids: { id: string; last: number }[]; lastMessageAt: number; name: string | null; tags: string[] };

export type HotLeadsResult = {
  ok: boolean; clinics: number; leads: number; by_reason: Partial<Record<HotReason, number>>; dropped: number;
  requests: number; messages_read: number; contacts_read: number; skipped: string[]; errors: string[];
};

export async function syncHotLeads(opts: {
  db: SupabaseClient; keys: Record<string, { location_id: string; api_key: string }>; fetchImpl?: typeof fetch; now?: Date; concurrency?: number;
}): Promise<HotLeadsResult> {
  const { db } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = (opts.now ?? new Date()).getTime();
  const seenIso = new Date(now).toISOString();
  const out: HotLeadsResult = { ok: false, clinics: 0, leads: 0, by_reason: {}, dropped: 0, requests: 0, messages_read: 0, contacts_read: 0, skipped: [], errors: [] };
  const keyByLocation = new Map(Object.values(opts.keys).map((k) => [k.location_id, k.api_key]));

  const get = async (apiKey: string, path: string, version = "2021-04-15"): Promise<unknown> => {
    for (let attempt = 0; ; attempt++) {
      out.requests++;
      const res = await doFetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${apiKey}`, Version: version, Accept: "application/json" }, cache: "no-store" });
      if (res.status === 429 && attempt < 2) { await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1))); continue; }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GHL ${res.status} on ${path.split("?")[0]}`);
      return res.json();
    }
  };

  const { data: clients, error } = await db.from("clients").select("id, name, ghl_location_id").neq("stage", "churned").is("deleted_at", null).not("ghl_location_id", "is", null).order("name");
  if (error) throw new Error(`clients: ${error.message}`);

  const scan = async (client: { id: string; name: string; ghl_location_id: string }) => {
    const apiKey = keyByLocation.get(client.ghl_location_id);
    if (!apiKey) { out.skipped.push(`${client.name}: no GHL key`); return; }
    const loc = encodeURIComponent(client.ghl_location_id);

    // 1. Conversations with a message in the last 7 days, newest first, grouped by contact.
    const oldest = now - WINDOWS.callbackTagDays * 24 * HOUR;
    const convs = new Map<string, ConvSummary>();
    let after: unknown = null;
    for (let page = 0; page < 20; page++) {
      const body = Conversations.parse(await get(apiKey, `/conversations/search?locationId=${loc}&limit=100&sort=desc&sortBy=last_message_date${after !== null ? `&startAfterDate=${after}` : ""}`));
      for (const c of body.conversations) {
        const last = c.lastMessageDate ?? 0;
        if (!c.contactId || last < oldest) continue;
        const s = convs.get(c.contactId) ?? { ids: [], lastMessageAt: 0, name: null, tags: [] };
        s.ids.push({ id: c.id, last });
        s.lastMessageAt = Math.max(s.lastMessageAt, last);
        s.name = s.name ?? (c.fullName?.trim() || c.contactName?.trim() || null);
        s.tags = [...new Set([...s.tags, ...(c.tags ?? [])])];
        convs.set(c.contactId, s);
      }
      const tail = body.conversations.at(-1);
      if (!tail || body.conversations.length < 100 || (tail.lastMessageDate ?? 0) < oldest) break;
      after = tail.sort?.[0] ?? tail.lastMessageDate;
    }

    // 2. Every calendar's appointments: from the oldest cancellation that still counts to a year ahead.
    const calendars = Calendars.parse(await get(apiKey, `/calendars/?locationId=${loc}`)).calendars;
    const from = now - Math.max(WINDOWS.cancelledDays, WINDOWS.noShowDays) * 24 * HOUR;
    const events: z.infer<typeof Event>[] = [];
    for (const cal of calendars) {
      const r = await get(apiKey, `/calendars/events?locationId=${loc}&calendarId=${encodeURIComponent(cal.id)}&startTime=${from}&endTime=${now + AHEAD_DAYS * 24 * HOUR}`);
      if (r) events.push(...Events.parse(r).events);
    }
    const appts = appointmentFacts(events, now);
    // A patient logged Rescheduled on the confirmation desk counts as cancelled until they rebook.
    const { data: desk } = await db.from("confirmation_appointments").select("ghl_contact_id, status_at")
      .eq("client_id", client.id).eq("status", "rescheduled").gte("status_at", new Date(now - WINDOWS.cancelledDays * 24 * HOUR).toISOString());
    for (const d of (desk ?? []) as { ghl_contact_id: string | null; status_at: string }[]) {
      if (d.ghl_contact_id && Date.parse(d.status_at) > (appts.cancelledAt.get(d.ghl_contact_id) ?? -Infinity)) appts.cancelledAt.set(d.ghl_contact_id, Date.parse(d.status_at));
    }

    // 3. What was remembered about these contacts last time.
    const ids = [...new Set([...convs.keys(), ...appts.cancelledAt.keys(), ...appts.noShowAt.keys()])];
    const cache = new Map<string, Cached>();
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error: cacheError } = await db.from("hot_lead_contacts").select("*").eq("client_id", client.id).in("ghl_contact_id", ids.slice(i, i + 100));
      if (cacheError) throw new Error(`hot_lead_contacts: ${cacheError.message}`);
      for (const row of (data ?? []) as Cached[]) cache.set(row.ghl_contact_id, row);
    }
    const changed = new Map<string, Partial<Cached>>();
    const remember = (id: string, patch: Partial<Cached>) => {
      const merged = { ...(cache.get(id) ?? { ghl_contact_id: id, name: null, tags: [], contact_read_at: null, messages_read_for: null, last_inbound_sms_at: null, inbound_reschedule: false, inbound_callback: false }), ...patch };
      cache.set(id, merged);
      changed.set(id, merged);
    };

    // 4. Latest text in: re-read only conversations with something new since last time.
    const keywordFrom = now - WINDOWS.keywordHours * HOUR;
    for (const [contactId, s] of convs) {
      if (s.lastMessageAt < keywordFrom) continue;
      const lastIso = new Date(s.lastMessageAt).toISOString();
      const readFor = cache.get(contactId)?.messages_read_for;
      if (readFor && Date.parse(readFor) === s.lastMessageAt) continue;
      let latest: ReturnType<typeof latestInboundSms> = null;
      for (const c of s.ids.filter((x) => x.last >= keywordFrom)) {
        out.messages_read++;
        const r = await get(apiKey, `/conversations/${encodeURIComponent(c.id)}/messages?limit=50`);
        const found = r ? latestInboundSms(Messages.parse(r).messages.messages) : null;
        if (found && (!latest || found.at > latest.at)) latest = found;
      }
      remember(contactId, {
        name: s.name, tags: s.tags, messages_read_for: lastIso,
        last_inbound_sms_at: latest ? new Date(latest.at).toISOString() : null,
        inbound_reschedule: latest?.reschedule ?? false, inbound_callback: latest?.callback ?? false,
      });
    }

    // 5. Decide each contact. Name and tags come from the conversation, or from GHL for the few without one.
    const leads: { id: string; name: string | null; lead: Lead }[] = [];
    for (const id of ids) {
      const s = convs.get(id);
      const c = cache.get(id);
      // A remembered text older than the windows is ignored by decideLead.
      const facts = {
        upcoming: appts.upcoming.has(id),
        lastInboundAt: c?.last_inbound_sms_at ? Date.parse(c.last_inbound_sms_at) : null,
        inboundReschedule: !!c?.inbound_reschedule,
        inboundCallback: !!c?.inbound_callback,
        lastMessageAt: s?.lastMessageAt ?? null,
        cancelledAt: appts.cancelledAt.get(id) ?? null,
        noShowAt: appts.noShowAt.get(id) ?? null,
      };
      let tags = s?.tags ?? c?.tags ?? [];
      let name = s?.name ?? c?.name ?? null;
      let dnd = false;
      const maybe = decideLead({ ...facts, hidden: false, callbackTag: hasTag(tags, CALLBACK_TAGS) }, now);
      if (!maybe) continue;
      if (!s && !(c?.contact_read_at && now - Date.parse(c.contact_read_at) < CONTACT_FRESH_MS)) {
        out.contacts_read++;
        const r = await get(apiKey, `/contacts/${encodeURIComponent(id)}`, "2021-07-28");
        if (!r) continue; // contact deleted in GHL
        const contact = Contact.parse(r).contact;
        tags = contact.tags ?? [];
        name = [contact.firstName, contact.lastName].map((x) => x?.trim()).filter(Boolean).join(" ") || null;
        dnd = contact.dnd === true;
        remember(id, { name, tags, contact_read_at: seenIso });
      }
      const lead = decideLead({ ...facts, hidden: dnd || hasTag(tags, HIDE_TAGS, true), callbackTag: hasTag(tags, CALLBACK_TAGS) }, now);
      if (lead) leads.push({ id, name, lead });
    }

    // 6. Save: what to remember, the current leads, and drop the ones no longer hot.
    if (changed.size) {
      const rows = [...changed.values()].map((r) => ({ client_id: client.id, ...r }));
      const { error: e } = await db.from("hot_lead_contacts").upsert(rows, { onConflict: "client_id,ghl_contact_id" });
      if (e) throw new Error(`hot_lead_contacts: ${e.message}`);
    }
    if (leads.length) {
      const { error: e } = await db.from("hot_leads").upsert(leads.map((l) => ({
        client_id: client.id, ghl_contact_id: l.id, patient_name: l.name, reason: l.lead.reason,
        signal_at: new Date(l.lead.signal_at).toISOString(), last_reply_at: l.lead.last_reply_at ? new Date(l.lead.last_reply_at).toISOString() : null,
        last_seen_at: seenIso, dropped_at: null,
      })), { onConflict: "client_id,ghl_contact_id" });
      if (e) throw new Error(`hot_leads: ${e.message}`);
    }
    let drop = db.from("hot_leads").update({ dropped_at: seenIso }, { count: "exact" }).eq("client_id", client.id).is("dropped_at", null);
    if (leads.length) drop = drop.not("ghl_contact_id", "in", `(${leads.map((l) => `"${l.id.replace(/"/g, "")}"`).join(",")})`);
    const { error: dropError, count } = await drop;
    if (dropError) throw new Error(`hot_leads drop: ${dropError.message}`);
    out.dropped += count ?? 0;
    out.leads += leads.length;
    for (const l of leads) out.by_reason[l.lead.reason] = (out.by_reason[l.lead.reason] ?? 0) + 1;
    out.clinics++;
  };

  // A few clinics at a time (GHL limits each sub-account separately).
  const queue = [...((clients ?? []) as { id: string; name: string; ghl_location_id: string }[])];
  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      try { await scan(c); } catch (err) { out.errors.push(`${c.name}: ${(err as Error).message}`); }
    }
  }));
  out.ok = out.errors.length === 0;
  return out;
}
