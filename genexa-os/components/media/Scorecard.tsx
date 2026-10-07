import type { ScoreCell, Scorecard as ScorecardData } from "@/lib/queries/media";
import { NoData, PILL, th } from "./Cells";

function Cell({ cell, empty, threshold }: { cell: ScoreCell; empty: string; threshold: string | null }) {
  if (cell.display === null) return <td className="px-3 py-2"><NoData text={empty} /></td>;
  return (
    <td className="px-3 py-2">
      <span className={`rounded px-1.5 py-0.5 text-xs font-medium tabular-nums ${cell.colour ? PILL[cell.colour] : "bg-stale-bg text-stale"}`} title={threshold ?? undefined}>
        {cell.display}
      </span>
      {cell.detail ? <span className="ml-2 text-xs text-muted">{cell.detail}</span> : null}
    </td>
  );
}

/** The media buyer's week, from score_media_weekly. Hover a score for the threshold behind its colour. */
export function Scorecards({ cards }: { cards: ScorecardData[] }) {
  if (cards.length === 0) {
    return (
      <section className="rounded-lg border border-line bg-panel px-4 py-3">
        <h2 className="text-sm font-semibold">Media buyer scorecard</h2>
        <p className="mt-1 text-sm text-muted">No staff member has the media buyer role.</p>
      </section>
    );
  }
  return (
    <>
      {cards.map((card) => (
        <section key={card.staff_id} className="rounded-lg border border-line bg-panel">
          <h2 className="px-4 py-3 text-sm font-semibold">
            Scorecard · {card.name} <span className="font-normal text-muted">· weeks run Mon–Sun (ET)</span>
          </h2>
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className={th}>Metric</th>
                  <th className={th}>This week (from {card.week_start})</th>
                  <th className={th}>Last week (from {card.prev_week_start})</th>
                </tr>
              </thead>
              <tbody>
                {card.metrics.map((m) => (
                  <tr key={m.metric} className="border-t border-line">
                    <td className="px-3 py-2" title={m.threshold ?? undefined}>{m.label}</td>
                    <Cell cell={m.current} empty="no data" threshold={m.threshold} />
                    <Cell cell={m.previous} empty={m.currentOnly ? "not stored for past weeks" : "no data"} threshold={m.threshold} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}
