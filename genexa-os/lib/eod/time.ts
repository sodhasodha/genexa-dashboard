// An EOD belongs to the person's own calendar day, so these work in any timezone.

/** Today's date in a timezone as YYYY-MM-DD. Matches (now() at time zone tz)::date in eods_rules. */
export function localDate(timezone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** "07 Oct, 17:42" in a timezone. */
export function formatLocalTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(iso));
}

/** "Wed 07 Oct" for a YYYY-MM-DD date. */
export function formatDay(date: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "short" }).format(
    new Date(`${date}T12:00:00Z`),
  );
}

/** Length of a shift in hours from HH:MM[:SS] times. An end at or before the start runs overnight. */
export function shiftHours(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  let length = minutes(end) - minutes(start);
  if (length <= 0) length += 24 * 60;
  return Math.round((length / 60) * 100) / 100;
}
