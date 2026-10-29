// The time where a clinic is, for the confirmation desk. Pure: the clock is passed in.
// US rules allow these calls from 08:00 to 21:00 in the patient's own time; the clinic's
// timezone stands in for the patient's.

export type CallWindow = "early" | "late" | null;

/** "6:12 AM CST" at the clinic, and whether that is too early or too late to call. */
export function clinicNow(now: Date, timeZone: string): { time: string; window: CallWindow } {
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(now);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now));
  return { time, window: hour < 8 ? "early" : hour >= 21 ? "late" : null };
}
