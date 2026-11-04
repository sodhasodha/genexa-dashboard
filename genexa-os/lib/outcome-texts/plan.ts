// Texting a clinic's manager for appointment outcomes: what to send and when. Pure: no network, no database.

export type Stage = "appointments_booked" | "no_show" | "closed_won" | "not_closed";
export type Outcome = "no_show" | "closed_won" | "not_closed";
export type Patient = { contact_id: string; name: string; stage: Stage; appointment: string; revenue: number };
export type AskStatus = "asked" | "reminded" | "logged" | "thinking" | "thinking_asked" | "done" | "unsent" | "not_ours";
export type Ask = {
  id: string;
  patient_contact_id: string;
  patient_name: string;
  appointment_at: string;
  status: AskStatus;
  asked_at: string;
  reminded_at: string | null;
  outcome: Outcome | null;
  amount: number | null;
  logged_at: string | null;
  follow_up_at: string | null;
};

// Appointments are 30 minutes; the manager is asked an hour after one ends.
export const ASK_AFTER_START_MS = 90 * 60 * 1000;
// Nothing older than this is asked about, even just after switching on or after an outage.
export const ASK_WITHIN_MS = 36 * 60 * 60 * 1000;
export const THINKING_FOLLOW_UP_MS = 48 * 60 * 60 * 1000;
// Texts only go out between these hours, clinic time. A question due later waits for the morning.
export const SEND_FROM_HOUR = 8;
export const SEND_UNTIL_HOUR = 21;
// The once-only re-ping for an unanswered question goes the morning after it was asked, from this hour.
export const REMIND_FROM_HOUR = 9;

export function localParts(at: Date, timeZone: string): { date: string; hour: number } {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

export const canText = (now: Date, timeZone: string) => {
  const { hour } = localParts(now, timeZone);
  return hour >= SEND_FROM_HOUR && hour < SEND_UNTIL_HOUR;
};

/** "Jane Smith" -> "Jane S". One-word names stay as they are. */
export function shortName(name: string): string {
  const [first, ...rest] = name.trim().split(/\s+/);
  const last = rest.filter((w) => !/^(jr|sr|ii|iii)\.?$/i.test(w)).pop();
  return last ? `${first} ${last[0].toUpperCase()}` : first || name;
}

export function timeOf(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso)).replace(":00", "");
}

export function dayOf(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));
}

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export type Plan = {
  // New questions: one text each.
  ask: Patient[];
  // Unanswered from a previous day: one text listing them all.
  remind: Ask[];
  // Thinking about it 48h ago and still not closed: one text each.
  followUp: Ask[];
  // Settled on the dashboard some other way (the clinic logged it, or it was cancelled): no more texts.
  close: Ask[];
};

export function plan(input: { now: Date; timeZone: string; liveFrom: string; patients: Patient[]; asks: Ask[] }): Plan {
  const { now, timeZone } = input;
  const out: Plan = { ask: [], remind: [], followUp: [], close: [] };
  const key = (contactId: string, at: string) => `${contactId}|${Date.parse(at)}`;
  const asked = new Set(input.asks.filter((a) => a.status !== "unsent").map((a) => key(a.patient_contact_id, a.appointment_at)));
  const byContact = new Map(input.patients.map((p) => [p.contact_id, p]));
  const sendable = canText(now, timeZone);
  const t = now.getTime();

  for (const p of input.patients) {
    const at = Date.parse(p.appointment);
    if (p.stage !== "appointments_booked" || asked.has(key(p.contact_id, p.appointment))) continue;
    if (at < Date.parse(input.liveFrom) || at + ASK_AFTER_START_MS > t || t - at > ASK_WITHIN_MS) continue;
    if (sendable) out.ask.push(p);
  }

  const today = localParts(now, timeZone);
  for (const a of input.asks) {
    const p = byContact.get(a.patient_contact_id);
    const sameAppointment = p && Date.parse(p.appointment) === Date.parse(a.appointment_at);
    if (a.status === "asked" || a.status === "reminded") {
      // The clinic logged it on the dashboard, or the appointment was moved or cancelled.
      if (!sameAppointment || p.stage !== "appointments_booked") { out.close.push(a); continue; }
      if (a.status === "asked" && sendable && today.hour >= REMIND_FROM_HOUR && localParts(new Date(a.asked_at), timeZone).date < today.date) out.remind.push(a);
    } else if (a.status === "thinking") {
      if (p && p.stage !== "not_closed") { out.close.push(a); continue; }
      if (sendable && a.follow_up_at && Date.parse(a.follow_up_at) <= t) out.followUp.push(a);
    }
  }
  return out;
}

export const askText = (p: Patient, timeZone: string) =>
  `Log outcome of ${p.name} (${timeOf(p.appointment, timeZone)} appt). Reply: Closed + amount / No Show / Show - Thinking about it`;

export function remindText(asks: Ask[], timeZone: string): string {
  if (asks.length === 1) {
    const a = asks[0];
    return `Reminder: outcome of ${a.patient_name} (${dayOf(a.appointment_at, timeZone)} ${timeOf(a.appointment_at, timeZone)})? Reply: Closed + amount / No Show / Show - Thinking about it`;
  }
  const list = asks.map((a) => `- ${a.patient_name} (${dayOf(a.appointment_at, timeZone)} ${timeOf(a.appointment_at, timeZone)})`).join("\n");
  return `Reminder, outcomes still needed:\n${list}\nReply e.g. "${shortName(asks[0].patient_name)} closed $5,000, ${shortName(asks[1].patient_name)} no show"`;
}

export const followUpText = (a: Ask) => `Did ${a.patient_name} get back to you? Reply Closed + amount, Still thinking, or No`;

export type Logged = { name: string; outcome: Outcome | "thinking" | "not_ours"; amount: number | null };

export function describe(l: Logged): string {
  const n = shortName(l.name);
  if (l.outcome === "closed_won") return l.amount ? `${n} closed ${money(l.amount)}` : `${n} closed (amount?)`;
  if (l.outcome === "no_show") return `${n} no-show`;
  if (l.outcome === "thinking") return `${n} showed, thinking about it`;
  if (l.outcome === "not_ours") return `${n} not from our ads, won't ask again`;
  return `${n} showed, not closed`;
}

export function confirmText(logged: Logged[], problems: string[]): string {
  const parts: string[] = [];
  if (logged.length) parts.push(`Logged: ${logged.map(describe).join(". ")}.`);
  const missing = logged.filter((l) => l.outcome === "closed_won" && !l.amount).map((l) => shortName(l.name));
  if (missing.length) parts.push(`What was the amount for ${missing.join(" and ")}?`);
  parts.push(...problems);
  if (logged.length) parts.push("Reply FIX to change.");
  return parts.join(" ");
}

type Attribution = { medium?: string | null; sessionSource?: string | null; utmSource?: string | null; campaign?: string | null; utmCampaign?: string | null };
export type LeadContact = { source?: string | null; attributionSource?: Attribution | null; lastAttributionSource?: Attribution | null };

// Genexa's patients come from its Meta ads, and GHL records that on the contact. A walk-in, podcast or referral
// patient has no such trace, so the manager is never texted about them.
const FROM_ADS = /\b(facebook|instagram|meta|paid social|fb|ig|genexa)\b/i;
export function isGenexaLead(c: LeadContact): boolean {
  const attributed = [c.attributionSource, c.lastAttributionSource].some((a) => a && [a.medium, a.sessionSource, a.utmSource, a.campaign, a.utmCampaign].some((v) => v && FROM_ADS.test(v)));
  return attributed || FROM_ADS.test(c.source ?? "");
}

export const FIX_TEXT = `What should it be? Reply e.g. "Jane S closed $8,500" or "Mike R no-show"`;
export const UNCLEAR_TEXT = `Sorry, didn't catch that. Reply e.g. "Jane S closed $8,500", "Mike R no-show" or "Jane S thinking about it"`;
export const isBareFix = (text: string) => /^\s*fix\W*\s*$/i.test(text);
