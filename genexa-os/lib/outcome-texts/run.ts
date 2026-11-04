import "server-only";
// Every 5 minutes: read the managers' replies and log them on the client dashboard (which writes GHL, which Cortana
// reads), then send whatever questions, reminders and follow-ups are due. Texts go through the clinic's own GHL.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GhlKeys } from "@/lib/integrations/ghl/sync";
import { dashboard } from "@/lib/outcome-proposals/run";
import { parseReply, type ReplyCandidate } from "./parse";
import {
  plan, askText, remindText, followUpText, confirmText, isBareFix, isGenexaLead, FIX_TEXT, UNCLEAR_TEXT, THINKING_FOLLOW_UP_MS, localParts, dayOf, timeOf,
  type Ask, type LeadContact, type Patient, type Logged, type Outcome,
} from "./plan";

const GHL = "https://services.leadconnectorhq.com";

type Texter = { id: string; contact_id: string; name: string; live_from: string; clients: { name: string; ghl_location_id: string | null } | null };
type Ghl = { locationId: string; token: string };
type GhlMessage = { id: string; direction?: string; body?: string; dateAdded?: string; messageType?: string };

async function ghl<T>(g: Ghl, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${GHL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${g.token}`, Version: "2021-07-28", Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GHL ${method} ${path.split("?")[0]} HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return (await res.json()) as T;
}

async function inbound(g: Ghl, contactId: string): Promise<GhlMessage[]> {
  const { conversations = [] } = await ghl<{ conversations?: { id: string }[] }>(g, "GET", `/conversations/search?locationId=${g.locationId}&contactId=${contactId}`);
  const out: GhlMessage[] = [];
  for (const c of conversations.slice(0, 3)) {
    const r = await ghl<{ messages?: { messages?: GhlMessage[] } }>(g, "GET", `/conversations/${c.id}/messages?limit=30`);
    out.push(...(r.messages?.messages ?? []).filter((m) => m.direction === "inbound" && m.body && /SMS/i.test(m.messageType ?? "SMS")));
  }
  return out.sort((a, b) => Date.parse(a.dateAdded ?? "") - Date.parse(b.dateAdded ?? ""));
}

export type OutcomeTextsResult = { ok: boolean; texters: number; asked: number; reminded: number; followed_up: number; replies: number; logged: number; errors: string[] };

export async function runOutcomeTexts(opts: { db: SupabaseClient; keys: GhlKeys; apiKey: string; now?: Date }): Promise<OutcomeTextsResult> {
  const { db } = opts;
  const r: OutcomeTextsResult = { ok: true, texters: 0, asked: 0, reminded: 0, followed_up: 0, replies: 0, logged: 0, errors: [] };
  const { data: texters, error } = await db.from("outcome_texters").select("id, contact_id, name, live_from, clients(name, ghl_location_id)").eq("active", true).returns<Texter[]>();
  if (error) return { ...r, ok: false, errors: [error.message] };

  for (const t of texters ?? []) {
    r.texters++;
    const locationId = t.clients?.ghl_location_id;
    const key = Object.values(opts.keys).find((k) => k.location_id === locationId);
    if (!locationId || !key) { r.errors.push(`${t.name}: no GHL key for the clinic`); continue; }
    const g: Ghl = { locationId, token: key.api_key };
    try {
      await runTexter({ db, g, t, apiKey: opts.apiKey, now: opts.now ?? new Date(), r });
    } catch (e) {
      r.errors.push(`${t.name}: ${(e as Error).message}`);
    }
  }
  r.ok = r.errors.length === 0;
  return r;
}

async function runTexter(o: { db: SupabaseClient; g: Ghl; t: Texter; apiKey: string; now: Date; r: OutcomeTextsResult }) {
  const { db, g, t, now, r } = o;
  const clinicName = t.clients?.name ?? "the clinic";
  const recent = await dashboard<{ clinic?: { name: string; timezone: string }; patients?: Patient[]; error?: string }>("/api/agent/recent", { location_id: g.locationId, days: 10 });
  if (recent.status !== 200 || !recent.json.clinic) throw new Error(`client dashboard: ${recent.json.error ?? `HTTP ${recent.status}`}`);
  const tz = recent.json.clinic.timezone;
  const patients = recent.json.patients ?? [];

  const send = async (body: string): Promise<boolean> => {
    try {
      const sent = await ghl<{ messageId?: string }>(g, "POST", "/conversations/messages", { type: "SMS", contactId: t.contact_id, message: body });
      await db.from("outcome_texts").insert({ texter_id: t.id, direction: "out", ghl_message_id: sent.messageId ?? null, body });
      return true;
    } catch (e) {
      await db.from("outcome_texts").insert({ texter_id: t.id, direction: "out", body, error: (e as Error).message.slice(0, 500) });
      r.errors.push(`${t.name}: send failed: ${(e as Error).message}`);
      return false;
    }
  };
  const loadAsks = async () => {
    const since = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await db.from("outcome_asks").select("*").eq("texter_id", t.id).gte("appointment_at", since).order("appointment_at");
    return (data ?? []).map((a) => ({ ...a, amount: a.amount === null ? null : Number(a.amount) })) as Ask[];
  };
  const log = async (a: Ask, outcome: Outcome, amount: number | null) => {
    const res = await dashboard<{ ok?: boolean; error?: string }>("/api/agent/outcome", {
      location_id: g.locationId, contact_id: a.patient_contact_id, outcome, amount,
      purchase_date: outcome === "closed_won" ? localParts(new Date(a.appointment_at), tz).date : undefined,
      confirmed_by: t.name, via: "sms",
    });
    if (!res.json.ok) throw new Error(res.json.error ?? `HTTP ${res.status}`);
  };

  // 1. Replies. Each is claimed by its GHL id first, so it is handled once. Texts that arrive between two runs are
  // read together and answered with one text, so three quick messages don't get three answers.
  const replies = (await inbound(g, t.contact_id)).filter((m) => Date.parse(m.dateAdded ?? "") >= Date.parse(t.live_from));
  const claimed: { id: string; body: string; at: string }[] = [];
  for (const m of replies) {
    const { data } = await db.from("outcome_texts").insert({ texter_id: t.id, direction: "in", ghl_message_id: m.id, body: m.body!, at: m.dateAdded }).select("id").maybeSingle();
    if (data) claimed.push({ id: data.id, body: m.body!, at: m.dateAdded! });
  }
  r.replies += claimed.length;
  const ids = claimed.map((c) => c.id);
  if (claimed.length && claimed.every((c) => isBareFix(c.body))) await send(FIX_TEXT);
  else if (claimed.length) {
    const asks = await loadAsks();
    const weekAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    const pool = asks.filter((a) => !["done", "not_ours"].includes(a.status) || (a.logged_at && Date.parse(a.logged_at) >= weekAgo));
    const candidates: ReplyCandidate[] = pool.map((a, i) => ({
      ref: i + 1, name: a.patient_name, appointment: `${dayOf(a.appointment_at, tz)} ${timeOf(a.appointment_at, tz)}`,
      standing: a.status === "asked" || a.status === "reminded" ? "waiting for his answer"
        : a.status === "thinking" ? "logged as showed, thinking about it"
        : a.status === "thinking_asked" ? "showed and was thinking about it; he was just asked if they got back to him"
        : a.status === "not_ours" ? "marked as not from Genexa"
        : `already logged as ${a.outcome}${a.amount ? ` $${a.amount}` : ""}`,
    }));
    const { data: history } = await db.from("outcome_texts").select("direction, body").eq("texter_id", t.id).lt("at", claimed[0].at).order("at", { ascending: false }).limit(6);
    const reply = claimed.filter((c) => !isBareFix(c.body)).map((c) => c.body.trim()).join("\n");
    let parsed;
    try {
      parsed = await parseReply({ clinic: clinicName, reply, candidates, recentTexts: (history ?? []).reverse() as { direction: "in" | "out"; body: string }[] }, { apiKey: o.apiKey });
    } catch (e) {
      await db.from("outcome_texts").update({ error: (e as Error).message.slice(0, 500) }).in("id", ids);
      r.errors.push(`${t.name}: parse failed: ${(e as Error).message}`);
    }
    if (parsed) {
      const logged: Logged[] = [];
      const problems: string[] = [];
      for (const p of parsed.outcomes) {
        const a = pool[p.ref - 1];
        try {
          if (p.outcome === "not_ours") {
            await db.from("outcome_asks").update({ status: "not_ours", error: null }).eq("id", a.id);
            logged.push({ name: a.patient_name, outcome: "not_ours", amount: null });
          } else if (p.outcome === "thinking") {
            if (a.status === "thinking_asked") {
              await db.from("outcome_asks").update({ status: "done" }).eq("id", a.id);
            } else {
              await log(a, "not_closed", null);
              await db.from("outcome_asks").update({ status: "thinking", outcome: "not_closed", amount: null, logged_at: now.toISOString(), follow_up_at: new Date(now.getTime() + THINKING_FOLLOW_UP_MS).toISOString(), error: null }).eq("id", a.id);
            }
            logged.push({ name: a.patient_name, outcome: "thinking", amount: null });
          } else {
            await log(a, p.outcome, p.amount);
            const settled = a.status === "thinking" || a.status === "thinking_asked" || a.status === "done";
            await db.from("outcome_asks").update({ status: settled ? "done" : "logged", outcome: p.outcome, amount: p.amount, logged_at: now.toISOString(), error: null }).eq("id", a.id);
            logged.push({ name: a.patient_name, outcome: p.outcome, amount: p.amount });
            r.logged++;
          }
        } catch (e) {
          await db.from("outcome_asks").update({ error: (e as Error).message.slice(0, 500) }).eq("id", a.id);
          problems.push(`Couldn't log ${a.patient_name}, our team will do it.`);
          r.errors.push(`${t.name}: log ${a.patient_name} failed: ${(e as Error).message}`);
        }
      }
      await db.from("outcome_texts").update({ parsed }).in("id", ids);
      if (logged.length || problems.length) await send(confirmText(logged, problems));
      else if (parsed.unclear) await send(UNCLEAR_TEXT);
    }
  }

  // 2. Questions, the once-only morning reminder, and the 48h thinking follow-up.
  const due = plan({ now, timeZone: tz, liveFrom: t.live_from, patients, asks: await loadAsks() });
  for (const a of due.close) await db.from("outcome_asks").update({ status: "done" }).eq("id", a.id);
  for (const p of due.ask) {
    // Only patients from Genexa's ads. One that isn't is recorded, so it is never looked up or asked about again.
    let lead: LeadContact | undefined;
    try {
      lead = (await ghl<{ contact?: LeadContact }>(g, "GET", `/contacts/${p.contact_id}`)).contact;
    } catch (e) {
      r.errors.push(`${t.name}: lead source for ${p.name}: ${(e as Error).message}`);
      continue;
    }
    if (!lead || !isGenexaLead(lead)) {
      await db.from("outcome_asks").insert({ texter_id: t.id, patient_contact_id: p.contact_id, patient_name: p.name, appointment_at: p.appointment, status: "not_ours", asked_at: now.toISOString() });
      continue;
    }
    const fields = { status: "asked", patient_name: p.name, asked_at: now.toISOString() };
    let { data: row } = await db.from("outcome_asks").insert({ texter_id: t.id, patient_contact_id: p.contact_id, appointment_at: p.appointment, ...fields }).select("id").maybeSingle();
    // Already there: only an earlier text that failed is tried again; otherwise another run asked already.
    if (!row) ({ data: row } = await db.from("outcome_asks").update(fields).eq("texter_id", t.id).eq("patient_contact_id", p.contact_id).eq("appointment_at", p.appointment).eq("status", "unsent").select("id").maybeSingle());
    if (!row) continue;
    if (await send(askText(p, tz))) r.asked++;
    else await db.from("outcome_asks").update({ status: "unsent" }).eq("id", row.id);
  }
  if (due.remind.length && (await send(remindText(due.remind, tz)))) {
    await db.from("outcome_asks").update({ status: "reminded", reminded_at: now.toISOString() }).in("id", due.remind.map((a) => a.id));
    r.reminded += due.remind.length;
  }
  for (const a of due.followUp) {
    if (await send(followUpText(a))) {
      await db.from("outcome_asks").update({ status: "thinking_asked" }).eq("id", a.id);
      r.followed_up++;
    }
  }
}
