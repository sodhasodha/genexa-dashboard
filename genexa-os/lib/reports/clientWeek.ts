// The weekly report for one clinic, as short markdown. Pure formatting: every
// number arrives from client_week_report (SQL). Only the clinic's name and its
// numbers go in, so no patient detail can appear. Null prints as "no data".
import { changeRatio, formatValue, type Unit } from "@/lib/format";

type N = number | string | null;

/** One row of client_week_report(p_week_start). */
export type ClientWeekRow = {
  client_id: string;
  client_name: string;
  week_start: string;
  week_end: string;
  spend: N; leads: N; booked: N; confirmed: N; shows: N; no_shows: N; closes: N; revenue: N;
  cost_per_booked: N; show_rate: N;
  prev_spend: N; prev_leads: N; prev_booked: N; prev_confirmed: N; prev_shows: N; prev_no_shows: N;
  prev_closes: N; prev_revenue: N; prev_cost_per_booked: N; prev_show_rate: N;
};

export const NO_DATA = "no data";

const num = (v: N | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};
const show = (v: number | null, unit: Unit) => formatValue(v, unit) ?? NO_DATA;
const plural = (n: number, one: string, many: string) => `${formatValue(n, "count")} ${n === 1 ? one : many}`;

/** "28 Sep" from YYYY-MM-DD. */
export function shortDate(date: string, withYear = false): string {
  const [year, month, day] = date.slice(0, 10).split("-").map(Number);
  return `${day} ${MONTHS[month - 1]}${withYear ? ` ${year}` : ""}`;
}
// Spelled out here: Intl's short month names differ between runtimes ("Sep" / "Sept").
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** ", up 20%" against the week before; rates move in points. Empty when it cannot be said. */
function movement(current: number | null, previous: number | null, unit: Unit): string {
  if (current === null || previous === null) return "";
  if (current === previous) return ", no change";
  if (unit === "percent") {
    const points = Math.abs((current - previous) * 100).toFixed(1);
    return `, ${current > previous ? "up" : "down"} ${points} points`;
  }
  const change = changeRatio(current, previous);
  if (change === null) return "";
  return `, ${change > 0 ? "up" : "down"} ${Math.abs(change * 100).toFixed(0)}%`;
}

const LINES: { label: string; key: keyof ClientWeekRow; prev: keyof ClientWeekRow; unit: Unit }[] = [
  { label: "Ad spend", key: "spend", prev: "prev_spend", unit: "money" },
  { label: "Leads", key: "leads", prev: "prev_leads", unit: "count" },
  { label: "Consultations booked", key: "booked", prev: "prev_booked", unit: "count" },
  { label: "Confirmed", key: "confirmed", prev: "prev_confirmed", unit: "count" },
  { label: "Showed", key: "shows", prev: "prev_shows", unit: "count" },
  { label: "No-shows", key: "no_shows", prev: "prev_no_shows", unit: "count" },
  { label: "Show rate", key: "show_rate", prev: "prev_show_rate", unit: "percent" },
  { label: "Closed", key: "closes", prev: "prev_closes", unit: "count" },
  { label: "Revenue", key: "revenue", prev: "prev_revenue", unit: "money" },
  { label: "Cost per booked consultation", key: "cost_per_booked", prev: "prev_cost_per_booked", unit: "money" },
];

function headline(row: ClientWeekRow): string {
  const leads = num(row.leads), booked = num(row.booked), shows = num(row.shows), closes = num(row.closes), revenue = num(row.revenue);
  if (leads === null || booked === null || shows === null || closes === null) {
    return `Some of this week's numbers are missing. They show as "${NO_DATA}" below.`;
  }
  const money = revenue === null ? "" : ` for ${show(revenue, "money")} in revenue`;
  return `${plural(leads, "lead", "leads")} came in and ${plural(booked, "consultation was", "consultations were")} booked. `
    + `${plural(shows, "patient", "patients")} showed and ${plural(closes, "sale", "sales")} closed${closes > 0 ? money : ""}.`;
}

export function composeClientWeekReport(row: ClientWeekRow): string {
  const lines = LINES.map(({ label, key, prev, unit }) => {
    const current = num(row[key]);
    const previous = num(row[prev]);
    return `- ${label}: ${show(current, unit)} (week before: ${show(previous, unit)}${movement(current, previous, unit)})`;
  });
  return [
    `# ${row.client_name}`,
    "",
    `Week of ${shortDate(row.week_start)} to ${shortDate(row.week_end, true)}, compared with the week before.`,
    "",
    headline(row),
    "",
    ...lines,
    "",
  ].join("\n");
}
