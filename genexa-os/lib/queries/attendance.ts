import "server-only";
import { createClient } from "@/lib/supabase/server";
import { addDays, etToday } from "@/lib/time";

/** What the clock control shows for the logged-in person (SQL function my_attendance). */
export type MyAttendance = {
  staff_id: string;
  timezone: string;
  day: string;
  rostered: boolean;
  excused: boolean;
  shift_label: string | null;
  state: "not_clocked_in" | "clocked_in" | "clocked_out";
  status: string | null;
  minutes_late: number | null;
  clock_in_label: string | null;
  clock_out_label: string | null;
  show: boolean;
};

/** Null when there is nothing to show (not rostered today and no open clock-in) or the read fails. */
export async function getMyAttendance(): Promise<MyAttendance | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("my_attendance");
  if (error) return null;
  const row = ((data ?? []) as MyAttendance[])[0];
  return row?.show ? row : null;
}

export type AttendanceToday = {
  staff_id: string;
  name: string;
  role: string;
  timezone: string;
  date: string;
  is_working: boolean;
  excused: boolean;
  override_kind: string | null;
  override_note: string | null;
  shift_label: string | null;
  attendance_id: string | null;
  status: string | null;
  minutes_late: number | null;
  manual: boolean | null;
  clock_in_label: string | null;
  clock_out_label: string | null;
  state: "on_time" | "late" | "no_show" | "excused" | "off" | "not_started" | "due";
};

/** Everyone on the roster for their own local today (view attendance_today). */
export async function getAttendanceToday(): Promise<AttendanceToday[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("attendance_today").select("*").order("role").order("name");
  if (error) throw new Error(`attendance_today: ${error.message}`);
  return (data ?? []) as AttendanceToday[];
}

export type AttendanceWeekCell = {
  week_start: string;
  /** On-time shifts as a percentage of rostered shifts. Null = nothing rostered. */
  pct: number | null;
  on_time: number;
  rostered: number;
  late: number | null;
  no_shows: number | null;
  colour: string | null;
};
export type AttendanceWeeks = { weeks: string[]; people: { staff_id: string; cells: AttendanceWeekCell[] }[] };

/**
 * This week and the previous `count - 1`, newest first, per person, read from
 * score_attendance_weekly (all figures and colours are computed there).
 */
export async function getAttendanceWeeks(count = 5): Promise<AttendanceWeeks> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("score_attendance_weekly")
    .select("staff_id, week_start, metric, value, numerator, denominator, colour")
    .order("week_start", { ascending: false });
  if (error) throw new Error(`score_attendance_weekly: ${error.message}`);
  type Raw = { staff_id: string; week_start: string; metric: string; value: number | null; numerator: number | null; denominator: number | null; colour: string | null };
  const rows = (data ?? []) as Raw[];
  const weeks = [...new Set(rows.map((r) => r.week_start))].slice(0, count);
  const num = (v: number | string | null) => (v === null ? null : Number(v));
  const people = new Map<string, Map<string, AttendanceWeekCell>>();
  for (const r of rows) {
    if (!weeks.includes(r.week_start)) continue;
    if (!people.has(r.staff_id)) people.set(r.staff_id, new Map());
    const byWeek = people.get(r.staff_id)!;
    if (!byWeek.has(r.week_start)) byWeek.set(r.week_start, { week_start: r.week_start, pct: null, on_time: 0, rostered: 0, late: null, no_shows: null, colour: null });
    const cell = byWeek.get(r.week_start)!;
    if (r.metric === "attendance_pct") {
      cell.pct = num(r.value);
      cell.on_time = num(r.numerator) ?? 0;
      cell.rostered = num(r.denominator) ?? 0;
      cell.colour = r.colour;
    } else if (r.metric === "late_count") cell.late = num(r.value);
    else if (r.metric === "no_shows") cell.no_shows = num(r.value);
  }
  return {
    weeks,
    people: [...people.entries()].map(([staff_id, byWeek]) => ({
      staff_id,
      cells: weeks.flatMap((w) => {
        const cell = byWeek.get(w);
        return cell ? [cell] : [];
      }),
    })),
  };
}

export type AttendanceLogRow = {
  id: string;
  staff_id: string;
  name: string;
  timezone: string;
  date: string;
  status: string | null;
  minutes_late: number | null;
  manual: boolean;
  overtime_approved: boolean;
  note: string | null;
  approved_by_name: string | null;
  shift_label: string | null;
  clock_in_label: string | null;
  clock_out_label: string | null;
  clock_in_local: string | null;
  clock_out_local: string | null;
};

/** Attendance rows of the last `days` days (view attendance_log), newest first. */
export async function getAttendanceLog(days = 14): Promise<AttendanceLogRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("attendance_log")
    .select("*")
    .gte("date", addDays(etToday(), -days))
    .order("date", { ascending: false })
    .order("name");
  if (error) throw new Error(`attendance_log: ${error.message}`);
  return (data ?? []) as AttendanceLogRow[];
}

export type ShiftOverride = {
  id: string;
  staff_id: string;
  date: string;
  kind: "sick" | "holiday" | "swap" | "custom";
  shift_start: string | null;
  shift_end: string | null;
  note: string | null;
  /** True from today (ET) onwards. */
  upcoming: boolean;
};

/** Overrides from 14 days back onwards, soonest first. Removed ones are left out. */
export async function getShiftOverrides(): Promise<ShiftOverride[]> {
  const supabase = await createClient();
  const today = etToday();
  const { data, error } = await supabase
    .from("shift_overrides")
    .select("id, staff_id, date, kind, shift_start, shift_end, note")
    .is("deleted_at", null)
    .gte("date", addDays(today, -14))
    .order("date");
  if (error) throw new Error(`shift_overrides: ${error.message}`);
  return ((data ?? []) as Omit<ShiftOverride, "upcoming">[]).map((o) => ({ ...o, upcoming: o.date >= today }));
}
