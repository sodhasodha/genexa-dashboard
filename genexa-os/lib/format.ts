/** "4m", "3h", "2d" — how long ago, from a number of minutes. Null in, null out. */
export function formatAge(minutes: number | null | undefined): string | null {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return null;
  const m = Math.max(0, Math.floor(minutes));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 48) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / (60 * 24))}d ago`;
}
