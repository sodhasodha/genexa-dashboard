// Pay weeks are Mon–Sun in America/New_York. Dates are YYYY-MM-DD strings
// already cut in ET (see lib/time.ts etToday).
import { addDays } from "@/lib/time";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** ISO day of week: 1 = Monday … 7 = Sunday. */
function isoDow(date: string): number {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

export const isDate = (v: unknown): v is string =>
  typeof v === "string" && DATE.test(v) && !Number.isNaN(new Date(`${v}T12:00:00Z`).getTime());

/** Monday of the week containing the date. */
export function weekStartOf(date: string): string {
  return addDays(date, 1 - isoDow(date));
}

/** The week the Sunday job builds: the one ending on the coming Sunday, or today if today is Sunday. */
export function payRunWeek(today: string): string {
  return weekStartOf(today);
}

/** The week the page opens on: the one ending today (Sunday), otherwise the one that just ended. */
export function defaultPayWeek(today: string): string {
  return isoDow(today) === 7 ? weekStartOf(today) : addDays(weekStartOf(today), -7);
}
