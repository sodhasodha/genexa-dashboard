import Link from "next/link";
import { formatValue } from "@/lib/format";
import type { Tile as TileData } from "@/lib/queries/overview";

/** A headline number with its change against the previous period. Displays only; computes nothing. */
export function Tile({ tile, prevLabel, large = false }: { tile: TileData; prevLabel: string; large?: boolean }) {
  const value = formatValue(tile.value, tile.unit);
  const previous = formatValue(tile.previous, tile.unit);
  const up = tile.change !== null && tile.change > 0;
  const flat = tile.change !== null && Math.abs(tile.change) < 0.0005;
  const good = tile.upIs === "neutral" || flat ? null : (tile.upIs === "good") === up;
  const tone = good === null ? "text-muted" : good ? "text-good" : "text-bad";
  return (
    <Link href={tile.href} className="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-panel p-4 hover:border-muted">
      <span className="truncate text-xs text-muted">{tile.label}</span>
      {value !== null ? (
        <span className={`${large ? "text-3xl" : "text-2xl"} font-semibold tabular-nums ${tile.state === "stale" ? "text-stale" : ""}`}>{value}</span>
      ) : (
        <span className={`${large ? "text-3xl" : "text-2xl"} font-semibold text-stale`}>no data</span>
      )}
      <span className="min-h-4 text-xs">
        {tile.state === "stale" ? (
          <span className="rounded bg-stale-bg px-1.5 py-0.5 text-stale">stale · {tile.note}</span>
        ) : tile.change !== null ? (
          <>
            <span className={`font-medium ${tone}`}>
              {flat ? "→" : up ? "▲" : "▼"} {Math.abs(tile.change * 100).toFixed(1)}%
            </span>
            <span className="text-muted"> vs {previous} {prevLabel}</span>
          </>
        ) : value !== null && previous !== null ? (
          <span className="text-muted">was {previous} {prevLabel}</span>
        ) : (
          <span className="text-muted">{tile.note ?? (value !== null ? `nothing recorded ${prevLabel}` : "")}</span>
        )}
      </span>
      {tile.sub ? <span className="truncate text-xs text-muted">{tile.sub}</span> : null}
    </Link>
  );
}
