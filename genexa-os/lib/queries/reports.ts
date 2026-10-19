import "server-only";
import { createClient } from "@/lib/supabase/server";
import { addDays, etToday } from "@/lib/time";

export type ReportStatus = "good" | "check" | "dont_send";
export type ReportRow = {
  client_id: string; name: string; launch_date: string | null;
  spend: number | null; leads: number; booked: number; shows: number; closes: number; revenue: number; roas: number | null;
  status: ReportStatus; reasons: string[];
  /** ROAS under the red line (scoring_config roas_red_below, 3x). */
  roas_bad: boolean;
};
export type ReportRange = { from: string; to: string; preset: "last_30" | "last_month" | "custom" };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The two presets, worked out from today in ET. Complete days only. */
export function presetRange(preset: "last_30" | "last_month", today: string = etToday()): { from: string; to: string } {
  if (preset === "last_30") return { from: addDays(today, -30), to: addDays(today, -1) };
  const firstThis = `${today.slice(0, 7)}-01`;
  const to = addDays(firstThis, -1);
  return { from: `${to.slice(0, 7)}-01`, to };
}

/** Reads ?from=&to= or ?preset=; anything invalid falls back to the last 30 days. */
export function parseReportRange(params: Record<string, string | string[] | undefined>, today: string = etToday()): ReportRange {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const preset = one(params.preset);
  if (preset === "last_month") return { ...presetRange("last_month", today), preset: "last_month" };
  const from = one(params.from), to = one(params.to);
  if (from && to && DATE.test(from) && DATE.test(to) && !Number.isNaN(Date.parse(from)) && !Number.isNaN(Date.parse(to)) && from <= to && from >= "2026-08-01" && to <= today) {
    const p30 = presetRange("last_30", today), pm = presetRange("last_month", today);
    return { from, to, preset: from === p30.from && to === p30.to ? "last_30" : from === pm.from && to === pm.to ? "last_month" : "custom" };
  }
  return { ...presetRange("last_30", today), preset: "last_30" };
}

const nums = ["spend", "leads", "booked", "shows", "closes", "revenue", "roas"] as const;

export async function getReports(range: { from: string; to: string }): Promise<ReportRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("client_report", { p_from: range.from, p_to: range.to });
  if (error) throw new Error(`client_report: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    ...r,
    ...Object.fromEntries(nums.map((k) => [k, r[k] === null || r[k] === undefined ? (k === "spend" || k === "roas" ? null : 0) : Number(r[k])])),
    reasons: (r.reasons as string[] | null) ?? [],
  }) as unknown as ReportRow);
}

export async function getReport(clientId: string, range: { from: string; to: string }): Promise<ReportRow | null> {
  return (await getReports(range)).find((r) => r.client_id === clientId) ?? null;
}
