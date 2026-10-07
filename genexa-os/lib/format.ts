/** "4m ago", "3h ago", "2d ago" — from a number of minutes. Null in, null out. */
export function formatAge(minutes: number | null | undefined): string | null {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return null;
  const m = Math.max(0, Math.floor(minutes));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 48) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / (60 * 24))}d ago`;
}

export type Unit = "money" | "count" | "percent";

/** Display a number. Null stays null: the caller shows "no data". */
export function formatValue(value: number | null | undefined, unit: Unit): string | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  if (unit === "money") {
    return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2 });
  }
  if (unit === "percent") return `${(value * 100).toFixed(1)}%`;
  return Math.round(value).toLocaleString("en-US");
}

/** Change against the previous period as a ratio (0.12 = up 12%). Null when it cannot be computed. */
export function changeRatio(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}
