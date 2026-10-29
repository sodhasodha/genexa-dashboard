import "server-only";
import { createClient } from "@/lib/supabase/server";

export type DeskStatus = "unconfirmed" | "confirmed" | "rescheduled" | "cancelled" | "unreachable" | "expired";
export type StatusFilter = "needs_action" | "confirmed" | "rescheduled" | "cancelled" | "all";
export const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "needs_action", label: "Needs action" }, { key: "confirmed", label: "Confirmed" }, { key: "rescheduled", label: "Rescheduled" },
  { key: "cancelled", label: "Cancelled" }, { key: "all", label: "All" },
];
export const OUTCOMES = [
  { key: "confirmed", label: "Confirmed" }, { key: "no_answer", label: "No answer" },
  { key: "voicemail", label: "Voicemail left" }, { key: "rescheduled", label: "Rescheduled" },
] as const;
export type Outcome = (typeof OUTCOMES)[number]["key"];
export const MAX_ATTEMPTS = 10;
const PH = "Asia/Manila";

export type DeskCall = { id: string; attempt: number; outcome: Outcome; by: string; at: string; edited_by: string | null; edited_at: string | null; text: string };

export type DeskRow = {
  id: string; client_id: string; clinic: string; location_label: string | null; patient_name: string | null; phone: string | null;
  scheduled_for: string; clinic_timezone: string; status: DeskStatus; status_source: "csr" | "ghl" | "system" | null; on_main_calendar: boolean; booked_on: "unconfirmed" | "main"; minutes_left: number;
  ghl_contact_id: string | null; ghl_location_id: string | null;
  /** Every call on the appointment, first to last. */
  calls: DeskCall[];
  attempts: number; last_at: string | null; last_outcome: Outcome | null; last_by: string | null; urgency: "red" | "amber" | "green" | "grey" | "none";
  /** Shown text, worked out here so the page only lays it out. */
  clinic_time: string; time_left: string; last_text: string | null; tel: string | null; ghl_url: string | null;
};

const fmt = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso));

/** "5h 20m", "45m", "1d 2h". */
export function timeLeft(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

/** A dialable tel: link from a stored phone ("+1 (555) 010-0123" -> "tel:+15550100123"). */
export function telLink(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, "");
  if (digits.replace(/\D/g, "").length < 7) return null;
  return `tel:${digits.startsWith("+") ? digits : digits.length === 10 ? `+1${digits}` : `+${digits}`}`;
}

/** The contact's page in GoHighLevel (app.gohighlevel.com sends a white-label user on to their own domain). */
export function ghlContactUrl(locationId: string | null, contactId: string | null): string | null {
  if (!locationId || !contactId) return null;
  return `https://app.gohighlevel.com/v2/location/${encodeURIComponent(locationId)}/contacts/detail/${encodeURIComponent(contactId)}`;
}

export const OUTCOME_LABEL: Record<string, string> = Object.fromEntries(OUTCOMES.map((o) => [o.key, o.label]));
export const STATUS_LABEL: Record<DeskStatus, string> = {
  unconfirmed: "Unconfirmed", confirmed: "Confirmed", rescheduled: "Rescheduled", cancelled: "Cancelled", unreachable: "Unreachable", expired: "Expired - unconfirmed",
};

export function matchesStatus(row: { status: DeskStatus }, f: StatusFilter): boolean {
  if (f === "all") return true;
  if (f === "needs_action") return row.status !== "confirmed" && row.status !== "cancelled";
  return row.status === f;
}

export function parseDeskFilters(params: Record<string, string | string[] | undefined>): { clinics: string[]; status: StatusFilter } {
  const raw = params.clinic;
  const clinics = (Array.isArray(raw) ? raw : raw ? raw.split(",") : []).filter((c) => /^[0-9a-f-]{36}$/i.test(c));
  const s = Array.isArray(params.status) ? params.status[0] : params.status;
  return { clinics, status: STATUS_FILTERS.some((x) => x.key === s) ? (s as StatusFilter) : "needs_action" };
}

/** Everything on the desk now, soonest first, plus the clinics for the filter. */
export async function getDesk(): Promise<{ rows: DeskRow[]; clinics: { id: string; name: string }[] }> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("confirmation_desk").select("*").order("scheduled_for");
  if (error) throw new Error(`confirmation_desk: ${error.message}`);
  const rows = ((data ?? []) as Omit<DeskRow, "clinic_time" | "time_left" | "last_text" | "tel" | "ghl_url">[]).map((r) => ({
    ...r,
    attempts: Number(r.attempts),
    minutes_left: Number(r.minutes_left),
    clinic_time: fmt(r.scheduled_for, r.clinic_timezone),
    time_left: timeLeft(Number(r.minutes_left)),
    last_text: r.last_at ? `${r.last_by ?? "Someone"} · ${fmt(r.last_at, PH)} · ${OUTCOME_LABEL[r.last_outcome ?? ""] ?? r.last_outcome}` : null,
    tel: telLink(r.phone),
    ghl_url: ghlContactUrl(r.ghl_location_id, r.ghl_contact_id),
    calls: ((r.calls ?? []) as Omit<DeskCall, "text">[]).map((c) => ({
      ...c,
      text: `${c.by} · ${fmt(c.at, PH)}${c.edited_by ? ` · changed by ${c.edited_by}` : ""}`,
    })),
  })) as DeskRow[];
  const clinics = [...new Map(rows.map((r) => [r.client_id, r.clinic])).entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  const { data: all } = await supabase.from("clinic_calendars").select("client_id, clients(name)").eq("kind", "unconfirmed");
  for (const c of (all ?? []) as unknown as { client_id: string; clients: { name: string } | null }[]) {
    if (c.clients && !clinics.some((x) => x.id === c.client_id)) clinics.push({ id: c.client_id, name: c.clients.name });
  }
  return { rows, clinics: clinics.sort((a, b) => a.name.localeCompare(b.name)) };
}

export type CsrStats = { staff_id: string; name: string; calls: number; appointments: number; confirmed: number; no_answer: number; voicemail: number; rescheduled: number; unreachable: number; first_call_minutes: number | null };
export type DeskTotals = { appointments: number; confirmed: number; rescheduled: number; cancelled: number; unreachable: number; expired: number; open: number; called: number };

export async function getCallCentre(from: string, to: string): Promise<{ people: CsrStats[]; totals: DeskTotals | null }> {
  const supabase = await createClient();
  const [p, t] = await Promise.all([
    supabase.rpc("confirmation_stats", { p_from: from, p_to: to }),
    supabase.rpc("confirmation_desk_totals", { p_from: from, p_to: to }),
  ]);
  if (p.error) throw new Error(`confirmation_stats: ${p.error.message}`);
  if (t.error) throw new Error(`confirmation_desk_totals: ${t.error.message}`);
  const num = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" && k !== "name" && k !== "staff_id" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v]));
  return { people: ((p.data ?? []) as Record<string, unknown>[]).map(num) as CsrStats[], totals: t.data?.[0] ? (num(t.data[0]) as DeskTotals) : null };
}
