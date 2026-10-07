/** "7 Oct 2026" from a YYYY-MM-DD date (a day already cut in ET by the database). Null in, null out. */
export function formatDay(day: string | null | undefined): string | null {
  if (!day) return null;
  const d = new Date(`${day.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
