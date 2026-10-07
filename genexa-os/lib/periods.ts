// Reporting periods for the Overview. Every period is compared like-for-like
// with the one before it: a part-finished week against the same days of last
// week, a part-finished month against the same days of last month.
import { addDays } from "@/lib/time";

export type PeriodKey = "today" | "week" | "month" | "last_month";
export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "last_month", label: "Last month" },
];

export type Period = {
  key: PeriodKey;
  label: string;
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  prevLabel: string;
};

const monthStart = (d: string) => `${d.slice(0, 8)}01`;
const daysInMonth = (d: string) => new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0)).getUTCDate();
const isoDow = (d: string) => ((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;

export const parsePeriod = (value: unknown): PeriodKey =>
  PERIODS.some((p) => p.key === value) ? (value as PeriodKey) : "month";

/** today is the current ET date (YYYY-MM-DD). */
export function resolvePeriod(key: PeriodKey, today: string): Period {
  if (key === "today") {
    const y = addDays(today, -1);
    return { key, label: "Today", from: today, to: today, prevFrom: y, prevTo: y, prevLabel: "yesterday" };
  }
  if (key === "week") {
    const from = addDays(today, -(isoDow(today) - 1));
    return { key, label: "This week", from, to: today, prevFrom: addDays(from, -7), prevTo: addDays(today, -7), prevLabel: "same days last week" };
  }
  const thisStart = monthStart(today);
  const lastStart = monthStart(addDays(thisStart, -1));
  if (key === "month") {
    const dayOfMonth = Number(today.slice(8, 10));
    const prevTo = addDays(lastStart, Math.min(dayOfMonth, daysInMonth(lastStart)) - 1);
    return { key, label: "This month", from: thisStart, to: today, prevFrom: lastStart, prevTo, prevLabel: "same days last month" };
  }
  const beforeStart = monthStart(addDays(lastStart, -1));
  return {
    key, label: "Last month", from: lastStart, to: addDays(thisStart, -1),
    prevFrom: beforeStart, prevTo: addDays(lastStart, -1), prevLabel: "the month before",
  };
}
