import "server-only";
import { z } from "zod";
import type { CurrentStaff } from "@/lib/auth/staff";
import { describeEod, referencedIds, summariseEod, type EodLine } from "@/lib/eod/describe";
import { readAnswers, type EodAnswers } from "@/lib/eod/schema";
import { formatDay, formatLocalTime, localDate, shiftHours } from "@/lib/eod/time";
import { createClient } from "@/lib/supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;

/** The ad exception types a media buyer can tick as cleared. */
const AD_EXCEPTION_TYPES = ["zero_spend", "account_cpb_high", "ad_fatigue", "ad_performance", "ad_disapproved"];

export type Option = { id: string; label: string };

export type EodForm = {
  /** The day this form files for: today in the person's own timezone. */
  date: string;
  dayLabel: string;
  /** Today's EOD when one is already filed. `eod` is null if it is not in the current shape. */
  existing: { submitted: string; eod: EodAnswers | null } | null;
  /** Length of the person's shift in hours, when a shift is set. */
  shiftHours: number | null;
  clients: Option[];
  exceptions: Option[];
  jobs: Option[];
};

const clip = (s: string, max = 90) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const byLabel = (a: Option, b: Option) => a.label.localeCompare(b.label);

type Refs = { clients: string[]; exceptions: string[]; jobs: string[] };
type ExceptionRow = { id: string; reason: string; status: string; resolved_at: string | null; client_id: string | null };
type JobRow = { id: string; title: string; status: string; done_at: string | null; client_id: string | null };

const exceptionLabel = (e: ExceptionRow, clients: Map<string, string>) =>
  clip([e.client_id ? clients.get(e.client_id) : null, e.reason, e.status === "resolved" ? "resolved" : null].filter(Boolean).join(" · "));
const jobLabel = (j: JobRow, clients: Map<string, string>) =>
  clip([j.title, j.client_id ? clients.get(j.client_id) : null, j.status.replace("todo", "to do")].filter(Boolean).join(" · "));

async function clientNames(supabase: Supabase): Promise<{ all: Map<string, string>; live: Option[] }> {
  const { data, error } = await supabase.from("clients").select("id, name, stage, deleted_at");
  if (error) throw new Error(`clients: ${error.message}`);
  const rows = (data ?? []) as { id: string; name: string; stage: string; deleted_at: string | null }[];
  return {
    all: new Map(rows.map((c) => [c.id, c.name])),
    live: rows.filter((c) => c.stage === "live" && c.deleted_at === null).map((c) => ({ id: c.id, label: c.name })).sort(byLabel),
  };
}

/** Display names for everything a set of EODs points at. */
async function loadNames(supabase: Supabase, refs: Refs, clients?: Map<string, string>): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const needClients = refs.clients.length > 0 || refs.exceptions.length > 0 || refs.jobs.length > 0;
  const clientMap = clients ?? (needClients ? (await clientNames(supabase)).all : new Map<string, string>());
  for (const id of refs.clients) {
    const name = clientMap.get(id);
    if (name) names.set(id, name);
  }
  if (refs.exceptions.length > 0) {
    const { data, error } = await supabase.from("exceptions").select("id, reason, status, resolved_at, client_id").in("id", refs.exceptions);
    if (error) throw new Error(`exceptions: ${error.message}`);
    for (const e of (data ?? []) as ExceptionRow[]) names.set(e.id, exceptionLabel(e, clientMap));
  }
  if (refs.jobs.length > 0) {
    const { data, error } = await supabase.from("tech_jobs").select("id, title, status, done_at, client_id").in("id", refs.jobs);
    if (error) throw new Error(`tech_jobs: ${error.message}`);
    for (const j of (data ?? []) as JobRow[]) names.set(j.id, jobLabel(j, clientMap));
  }
  return names;
}

/** Options first, then anything already saved that has since dropped off the list. */
function withSaved(options: Option[], savedIds: string[], names: Map<string, string>): Option[] {
  const have = new Set(options.map((o) => o.id));
  const extra = savedIds.filter((id) => !have.has(id) && names.has(id)).map((id) => ({ id, label: names.get(id)! }));
  return [...options, ...extra];
}

/**
 * Everything the logged-in person's form needs: the day it files for, today's EOD if
 * filed, and the lists to pick from. The save action checks ticked ids against the same lists.
 */
export async function getEodForm(me: CurrentStaff): Promise<EodForm> {
  const supabase = await createClient();
  const date = localDate(me.timezone);
  const since = new Date(Date.now() - 36 * 3_600_000).toISOString();
  const isToday = (iso: string | null) => iso !== null && localDate(me.timezone, new Date(iso)) === date;

  const [staff, today] = await Promise.all([
    supabase.from("staff").select("shift_start, shift_end").eq("id", me.id).maybeSingle(),
    supabase.from("eods").select("role, answers, submitted_at").eq("staff_id", me.id).eq("date", date).maybeSingle(),
  ]);
  if (staff.error) throw new Error(`staff: ${staff.error.message}`);
  if (today.error) throw new Error(`eods: ${today.error.message}`);

  const eod = today.data ? readAnswers(me.role, today.data.answers) : null;
  const form: EodForm = {
    date,
    dayLabel: formatDay(date),
    existing: today.data ? { submitted: formatLocalTime(today.data.submitted_at, me.timezone), eod } : null,
    shiftHours: shiftHours(staff.data?.shift_start ?? null, staff.data?.shift_end ?? null),
    clients: [],
    exceptions: [],
    jobs: [],
  };
  const saved = today.data ? referencedIds(me.role, today.data.answers) : { clients: [], exceptions: [], jobs: [] };

  if (me.role === "media_buyer") {
    const clients = await clientNames(supabase);
    // Open now, or resolved during the person's own today (a cleared exception is usually already resolved).
    const { data, error } = await supabase
      .from("exceptions")
      .select("id, reason, status, resolved_at, client_id")
      .eq("owner_id", me.id)
      .in("type", AD_EXCEPTION_TYPES)
      .or(`status.in.(open,snoozed),resolved_at.gte.${since}`)
      .order("first_detected_at");
    if (error) throw new Error(`exceptions: ${error.message}`);
    const rows = ((data ?? []) as ExceptionRow[]).filter((e) => e.status !== "resolved" || isToday(e.resolved_at));
    const names = await loadNames(supabase, saved, clients.all);
    form.clients = withSaved(clients.live, saved.clients, names);
    form.exceptions = withSaved(rows.map((e) => ({ id: e.id, label: exceptionLabel(e, clients.all) })), saved.exceptions, names);
  }

  if (me.role === "tech") {
    const clients = await clientNames(supabase);
    // Still open, or finished during the person's own today.
    const { data, error } = await supabase
      .from("tech_jobs")
      .select("id, title, status, done_at, client_id")
      .eq("owner_id", me.id)
      .is("deleted_at", null)
      .or(`status.neq.done,done_at.gte.${since}`)
      .order("due_at");
    if (error) throw new Error(`tech_jobs: ${error.message}`);
    const rows = ((data ?? []) as JobRow[]).filter((j) => j.status !== "done" || isToday(j.done_at));
    const names = await loadNames(supabase, saved, clients.all);
    form.jobs = withSaved(rows.map((j) => ({ id: j.id, label: jobLabel(j, clients.all) })), saved.jobs, names);
  }

  return form;
}

export type RecentEod = { id: string; date: string; day: string; submitted: string; summary: string };

/** The person's own last 7 EODs, newest first. Times are in their own timezone. */
export async function getMyRecentEods(me: CurrentStaff): Promise<RecentEod[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("eods")
    .select("id, date, role, answers, submitted_at")
    .eq("staff_id", me.id)
    .order("date", { ascending: false })
    .limit(7);
  if (error) throw new Error(`eods: ${error.message}`);
  return ((data ?? []) as { id: string; date: string; role: string; answers: unknown; submitted_at: string }[]).map((e) => ({
    id: e.id,
    date: e.date,
    day: formatDay(e.date),
    submitted: formatLocalTime(e.submitted_at, me.timezone),
    summary: summariseEod(e.role, e.answers),
  }));
}

export type EodStatusCell = { state: "filed" | "missing" | "due"; submitted: string | null };
export type EodStatusBoard = {
  /** YYYY-MM-DD, or null when no go-live date is set. */
  goLive: string | null;
  goLiveLabel: string | null;
  days: { day: string; label: string }[];
  /** cells line up with days; null = not expected to work that day. */
  people: { staff_id: string; name: string; role: string; cells: (EodStatusCell | null)[]; missed: number }[];
};

type StatusRow = { staff_id: string; name: string; role: string; day: string; filed: boolean; submitted_at: string | null; is_today: boolean };

/** Everyone's filed / missing status for the last 7 days, from eod_status_7d. Times in the viewer's timezone. */
export async function getEodStatusBoard(me: CurrentStaff): Promise<EodStatusBoard> {
  const supabase = await createClient();
  const [setting, status] = await Promise.all([
    supabase.from("app_settings").select("value").eq("key", "go_live_date").maybeSingle(),
    supabase.from("eod_status_7d").select("staff_id, name, role, day, filed, submitted_at, is_today").order("role").order("name").order("day"),
  ]);
  if (setting.error) throw new Error(`app_settings: ${setting.error.message}`);
  if (status.error) throw new Error(`eod_status_7d: ${status.error.message}`);
  const goLive = typeof setting.data?.value === "string" ? setting.data.value : null;
  const rows = (status.data ?? []) as StatusRow[];

  const days = [...new Set(rows.map((r) => r.day))].sort();
  const people = new Map<string, EodStatusBoard["people"][number]>();
  for (const r of rows) {
    let person = people.get(r.staff_id);
    if (!person) {
      person = { staff_id: r.staff_id, name: r.name, role: r.role, cells: days.map(() => null), missed: 0 };
      people.set(r.staff_id, person);
    }
    const state = r.filed ? "filed" : r.is_today ? "due" : "missing";
    if (state === "missing") person.missed += 1;
    person.cells[days.indexOf(r.day)] = { state, submitted: r.submitted_at ? formatLocalTime(r.submitted_at, me.timezone) : null };
  }
  return {
    goLive,
    goLiveLabel: goLive ? formatDay(goLive) : null,
    days: days.map((day) => ({ day, label: formatDay(day) })),
    people: [...people.values()],
  };
}

export type EodDetail = { name: string; role: string; day: string; submitted: string; lines: EodLine[] };

/** One EOD in full. The owner can read anyone's; everyone else only their own. */
export async function getEodDetail(me: CurrentStaff, staffId: string, day: string): Promise<EodDetail | null> {
  if (!z.uuid().safeParse(staffId).success || !z.iso.date().safeParse(day).success) return null;
  if (me.role !== "owner" && staffId !== me.id) return null;
  const supabase = await createClient();
  const [eod, staff] = await Promise.all([
    supabase.from("eods").select("role, answers, submitted_at").eq("staff_id", staffId).eq("date", day).maybeSingle(),
    supabase.from("staff").select("name").eq("id", staffId).maybeSingle(),
  ]);
  if (eod.error) throw new Error(`eods: ${eod.error.message}`);
  if (!eod.data || !staff.data) return null;
  const names = await loadNames(supabase, referencedIds(eod.data.role, eod.data.answers));
  return {
    name: staff.data.name,
    role: eod.data.role,
    day: formatDay(day),
    submitted: formatLocalTime(eod.data.submitted_at, me.timezone),
    lines: describeEod(eod.data.role, eod.data.answers, names),
  };
}
