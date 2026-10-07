import { formatValue, type Unit } from "@/lib/format";

// Display helpers for the Media Buying tables. They format; they never compute.

export const PILL: Record<string, string> = { green: "bg-good-bg text-good", amber: "bg-warn-bg text-warn", red: "bg-bad-bg text-bad" };
export const th = "whitespace-nowrap px-3 py-2 font-normal";
export const td = "whitespace-nowrap px-3 py-1.5 tabular-nums";

export const NoData = ({ text = "no data" }: { text?: string }) => <span className="text-stale">{text}</span>;

export type Kind = Unit | "pct_points" | "times";

/** money / count / percent (a 0–1 ratio) as elsewhere; pct_points = already a percentage; times = a frequency. */
export function show(value: number | null, kind: Kind): string | null {
  if (value === null || Number.isNaN(value)) return null;
  if (kind === "pct_points") return `${value.toFixed(2)}%`;
  if (kind === "times") return value.toFixed(2);
  return formatValue(value, kind);
}

export function Num({ value, kind, className = "" }: { value: number | null; kind: Kind; className?: string }) {
  return <td className={`${td} text-right ${className}`}>{show(value, kind) ?? <NoData />}</td>;
}
