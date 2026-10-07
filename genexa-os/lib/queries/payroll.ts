import "server-only";
import { createClient } from "@/lib/supabase/server";
import { addDays } from "@/lib/time";

// Typed reads of the payroll tables and views. Every number is computed in SQL
// (0026_payroll.sql); nothing is recalculated here. All of it is owner only:
// under RLS anyone else gets no rows.

export type PayType = "hourly" | "fixed_monthly" | "freelance";
export type PayStatus = "draft" | "approved" | "paid";

export type PayRun = {
  id: string;
  week_start: string;
  week_end: string;
  status: PayStatus;
  approved_at: string | null;
  paid_at: string | null;
  total: number;
  people: number;
  line_count: number;
  flag_count: number;
  draft_lines: number;
  approved_lines: number;
  paid_lines: number;
};

export type PayLine = {
  id: string;
  staff_id: string;
  name: string;
  email: string | null;
  role: string;
  pay_type: PayType | null;
  rostered_hours: number;
  worked_hours: number;
  late_count: number;
  no_show_count: number;
  rate: number | null;
  gross: number | null;
  adjustment: number;
  adjustment_reason: string | null;
  total: number;
  status: PayStatus;
  flags: string[];
  note: string | null;
  paid_at: string | null;
};

export type PayDay = {
  staff_id: string;
  date: string;
  attendance_id: string | null;
  shift_start: string | null;
  shift_end: string | null;
  clock_in: string | null;
  clock_out: string | null;
  status: string | null;
  overtime_approved: boolean;
  rostered_minutes: number;
  worked_minutes: number;
  no_clock_out: boolean;
  unrostered: boolean;
  overtime_unapproved: boolean;
};

export type SetupGap = { staff_id: string; name: string; role: string; pay_type: PayType | null; problem: string };

export type PayPerson = {
  staff_id: string;
  name: string;
  role: string;
  pay_type: PayType | null;
  hourly_rate: number | null;
  monthly_amount: number | null;
};

export type FreelanceJob = {
  id: string;
  staff_id: string;
  date: string;
  description: string;
  amount: number;
  pay_run_id: string | null;
};

const n = (v: unknown): number => Number(v ?? 0);
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/** The run for a week with its totals, or null when none has been built. */
export async function getPayRun(weekStart: string): Promise<PayRun | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("pay_run_totals").select("*").eq("week_start", weekStart).maybeSingle();
  if (error) throw new Error(`pay_run_totals: ${error.message}`);
  return data ? toRun(data) : null;
}

export async function getPayRunById(runId: string): Promise<PayRun | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("pay_run_totals").select("*").eq("id", runId).maybeSingle();
  if (error) throw new Error(`pay_run_totals: ${error.message}`);
  return data ? toRun(data) : null;
}

function toRun(r: Record<string, unknown>): PayRun {
  return {
    ...(r as unknown as PayRun),
    total: n(r.total), people: n(r.people), line_count: n(r.line_count), flag_count: n(r.flag_count),
    draft_lines: n(r.draft_lines), approved_lines: n(r.approved_lines), paid_lines: n(r.paid_lines),
  };
}

/** One row per person on the run, by name. */
export async function getPayLines(runId: string): Promise<PayLine[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("pay_run_lines")
    .select("id, staff_id, pay_type, rostered_hours, worked_hours, late_count, no_show_count, rate, gross, adjustment, adjustment_reason, total, status, flags, note, paid_at, staff(name, email, role)")
    .eq("pay_run_id", runId);
  if (error) throw new Error(`pay_run_lines: ${error.message}`);
  return (data ?? [])
    .map(({ staff, ...l }) => {
      const s = one(staff as { name: string; email: string | null; role: string } | { name: string; email: string | null; role: string }[] | null);
      return {
        ...(l as unknown as PayLine),
        name: s?.name ?? "Unknown",
        email: s?.email ?? null,
        role: s?.role ?? "",
        rostered_hours: n(l.rostered_hours), worked_hours: n(l.worked_hours), late_count: n(l.late_count), no_show_count: n(l.no_show_count),
        rate: nn(l.rate), gross: nn(l.gross), adjustment: n(l.adjustment), total: n(l.total), flags: (l.flags as string[] | null) ?? [],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The week's attendance days (only days with an attendance row can carry an overtime tick). */
export async function getPayDays(weekStart: string): Promise<PayDay[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("payroll_days")
    .select("staff_id, date, attendance_id, shift_start, shift_end, clock_in, clock_out, status, overtime_approved, rostered_minutes, worked_minutes, no_clock_out, unrostered, overtime_unapproved")
    .eq("week_start", weekStart)
    .not("attendance_id", "is", null)
    .order("date");
  if (error) throw new Error(`payroll_days: ${error.message}`);
  return (data ?? []).map((d) => ({ ...(d as PayDay), rostered_minutes: n(d.rostered_minutes), worked_minutes: n(d.worked_minutes) }));
}

export async function getSetupGaps(): Promise<SetupGap[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("payroll_setup_gaps").select("staff_id, name, role, pay_type, problem").order("name");
  if (error) throw new Error(`payroll_setup_gaps: ${error.message}`);
  return (data ?? []) as SetupGap[];
}

/** Everyone who can be on the payroll, with their pay settings. */
export async function getPayPeople(): Promise<PayPerson[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("staff")
    .select("id, name, role, staff_pay(pay_type, hourly_rate, monthly_amount)")
    .neq("status", "left")
    .order("name");
  if (error) throw new Error(`staff: ${error.message}`);
  type Pay = { pay_type: PayType | null; hourly_rate: number | null; monthly_amount: number | null };
  return (data ?? [])
    .map((s) => {
      const pay = one(s.staff_pay as Pay | Pay[] | null);
      return {
        staff_id: s.id as string, name: s.name as string, role: s.role as string,
        pay_type: pay?.pay_type ?? null, hourly_rate: nn(pay?.hourly_rate), monthly_amount: nn(pay?.monthly_amount),
      };
    })
    .filter((p) => p.role !== "owner" || p.pay_type !== null);
}

/** Freelance jobs dated inside the week. */
export async function getFreelanceJobs(weekStart: string): Promise<FreelanceJob[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("freelance_jobs")
    .select("id, staff_id, date, description, amount, pay_run_id")
    .is("deleted_at", null)
    .gte("date", weekStart)
    .lte("date", addDays(weekStart, 6))
    .order("date");
  if (error) throw new Error(`freelance_jobs: ${error.message}`);
  return (data ?? []).map((j) => ({ ...(j as FreelanceJob), amount: n(j.amount) }));
}
