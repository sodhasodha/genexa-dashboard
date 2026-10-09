// Day boundaries are cut in America/New_York; everything is stored in UTC.

const ET = "America/New_York";

/** Today's date in ET as YYYY-MM-DD. */
export function etToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Calendar arithmetic on a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Minutes ET is behind UTC at a given instant (240 in summer, 300 in winter). */
function etOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((at.getTime() - asUtc) / 60_000);
}

/** The UTC instant of 00:00 ET on a date. */
export function etMidnight(date: string): Date {
  const guess = new Date(`${date}T00:00:00Z`);
  const first = new Date(guess.getTime() + etOffsetMinutes(guess) * 60_000);
  // Re-check with the offset in force at the result (matters on DST change days).
  return new Date(guess.getTime() + etOffsetMinutes(first) * 60_000);
}

/** [start, end] of ET days from..to inclusive, as ISO strings (end = last millisecond of `to`). */
export function etRange(from: string, to: string): { start: string; end: string } {
  return {
    start: etMidnight(from).toISOString(),
    end: new Date(etMidnight(addDays(to, 1)).getTime() - 1).toISOString(),
  };
}

/**
 * [start, end] of AD ACCOUNT days from..to inclusive. Cortana files each account
 * day's delivery (spend, impressions, clicks) under that date at 00:00 UTC, so
 * the account day D is asked for as the UTC day D. Asking with ET midnights
 * returns the next account day instead.
 */
export function accountDayRange(from: string, to: string): { start: string; end: string } {
  return { start: `${from}T00:00:00.000Z`, end: `${to}T23:59:59.999Z` };
}
