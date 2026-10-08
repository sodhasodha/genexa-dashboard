// Deadlines with a date and a time. Pure: no database, no network, no clock of its own.
// The owner types a deadline as UK wall-clock time; it is stored as an instant (UTC) and
// shown to each person in their own timezone.

export const UK = "Europe/London";

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** The wall-clock fields of an instant in a timezone. */
function wallParts(at: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** Minutes the timezone is ahead of UTC at an instant (60 for London in summer, 0 in winter). */
export function offsetMinutes(at: Date, tz: string): number {
  const w = wallParts(at, tz);
  return Math.round((Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - at.getTime()) / 60_000);
}

/** A timezone name the runtime knows, else Europe/London. */
export function safeZone(tz: string | null | undefined): string {
  if (!tz) return UK;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return tz;
  } catch {
    return UK;
  }
}

/**
 * "2026-10-14T15:00" as typed into a datetime-local box, read as wall-clock time in `tz`
 * (UK by default), as an instant. Null when it is not a real date and time.
 *   - On the night the clocks go forward, a time inside the missing hour (01:00-01:59 UK)
 *     is moved on by the hour: 01:30 becomes 02:30 BST.
 *   - On the night they go back, 01:00-01:59 happens twice: the first one (BST) is used.
 */
export function localToInstant(local: string, tz: string = UK): Date | null {
  const m = LOCAL.exec(local.trim());
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(asUtc);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59) return null;
  // The offsets in force a day either side of the wall time: they differ only across a clock change.
  const before = offsetMinutes(new Date(asUtc - 24 * 3_600_000), tz);
  const after = offsetMinutes(new Date(asUtc + 24 * 3_600_000), tz);
  const valid = [before, after]
    .map((offset) => ({ offset, at: new Date(asUtc - offset * 60_000) }))
    .filter((c) => offsetMinutes(c.at, tz) === c.offset)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  // One reading on a normal day; two in the repeated hour (the earlier is used); none in the
  // missing hour, where the old offset carries the time across the change.
  return valid[0]?.at ?? new Date(asUtc - before * 60_000);
}

/** An instant as "YYYY-MM-DDTHH:mm" wall-clock time in `tz` (UK by default): the value of a datetime-local box. */
export function instantToLocal(iso: string | Date | null | undefined, tz: string = UK): string {
  if (!iso) return "";
  const at = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(at.getTime())) return "";
  const w = wallParts(at, tz);
  const p = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${p(w.year, 4)}-${p(w.month)}-${p(w.day)}T${p(w.hour)}:${p(w.minute)}`;
}

/** "BST", "GMT", "EDT", "GMT+5" for a timezone at an instant: a named abbreviation where there is one. */
export function zoneAbbr(at: Date, tz: string): string {
  const name = (locale: string) =>
    new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
  const named = [name("en-GB"), name("en-US"), name("en-IN"), name("en-AU")].find((n) => n && !/^(GMT|UTC)[+-]/.test(n));
  return named ?? name("en-GB");
}

/** "Wed 14 Oct, 15:00 BST": an instant as the person in `tz` reads it. Null in, null out. */
export function formatDeadline(iso: string | Date | null | undefined, tz: string | null | undefined): string | null {
  if (!iso) return null;
  const at = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(at.getTime())) return null;
  const zone = safeZone(tz);
  const part = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at).map((p) => [p.type, p.value]),
  );
  return `${part.weekday} ${part.day} ${part.month}, ${part.hour}:${part.minute} ${zoneAbbr(at, zone)}`;
}

/**
 * The countdown on a task row, from whole minutes to the deadline (negative once it has passed):
 * "due in 25m", "due in 3h", "due in 2d", "due now", "5m overdue", "2h overdue", "3d overdue".
 * Minutes under an hour, hours under a day, then days; always rounded down. Null in, null out.
 */
export function countdown(minutesToDeadline: number | null | undefined): string | null {
  if (minutesToDeadline === null || minutesToDeadline === undefined || Number.isNaN(Number(minutesToDeadline))) return null;
  const m = Math.trunc(Number(minutesToDeadline));
  if (m === 0) return "due now";
  const abs = Math.abs(m);
  const size = abs < 60 ? `${abs}m` : abs < 1440 ? `${Math.floor(abs / 60)}h` : `${Math.floor(abs / 1440)}d`;
  return m > 0 ? `due in ${size}` : `${size} overdue`;
}
