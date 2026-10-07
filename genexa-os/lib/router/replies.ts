// The two texts the app may post in a client's thread. Pure.

export type ClientThreadText = "Done ✓" | `Logged ✓${string}`;

export const DONE_TEXT = "Done ✓" as const;

/** True for exactly the texts the client workspace may receive. */
export const isClientThreadText = (text: string): text is ClientThreadText => text === DONE_TEXT || text.startsWith("Logged ✓");

/**
 * A due time as the clinic reads it. Midnight means "that day" (a date with no
 * time), so only the date is shown.
 */
export function formatDue(dueAt: string | Date, timezone: string): string {
  const at = typeof dueAt === "string" ? new Date(dueAt) : dueAt;
  const parts = (tz: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }).formatToParts(at);
  let p: Intl.DateTimeFormatPart[];
  try {
    p = parts(timezone);
  } catch {
    p = parts("America/New_York");
  }
  const get = (type: string) => p.find((x) => x.type === type)?.value ?? "";
  const date = `${get("weekday")} ${get("day")} ${get("month")}`;
  const midnight = get("hour") === "12" && get("minute") === "00" && get("dayPeriod").toUpperCase() === "AM";
  return midnight ? date : `${date}, ${get("hour")}:${get("minute")} ${get("dayPeriod")} ${get("timeZoneName")}`;
}

/** "Logged ✓ — Sameer will block Dr Patel's calendar by Wed 21 Oct". */
export function loggedReplyText(opts: { ownerName: string; title: string; dueAt: string | Date | null; timezone: string }): ClientThreadText {
  const title = opts.title.trim().replace(/[.!\s]+$/, "");
  const action = title.charAt(0).toLowerCase() + title.slice(1);
  const by = opts.dueAt ? ` by ${formatDue(opts.dueAt, opts.timezone)}` : "";
  return `Logged ✓ — ${opts.ownerName} will ${action}${by}`;
}
