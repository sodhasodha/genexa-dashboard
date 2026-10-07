import type { AdRow, Thresholds } from "@/lib/queries/media";
import { NoData, Num, td, th } from "./Cells";

const STATUS: Record<string, string> = { ACTIVE: "text-good", DISAPPROVED: "text-bad" };

/**
 * Per ad, from Cortana's own window rows. Active ads first, then 7-day spend.
 * `unavailable` replaces the table when the chosen clinic cannot have ad rows.
 */
export function AdsTable({
  rows, periodLabel, thresholds, showClinic, unavailable, scopedNames, truncatedAt,
}: {
  rows: AdRow[]; periodLabel: string; thresholds: Thresholds; showClinic: boolean;
  unavailable: string | null; scopedNames: string[]; truncatedAt: number | null;
}) {
  const fatigueRule = [thresholds.ad_fatigue_frequency, thresholds.ad_fatigue_ctr_drop_pct].filter(Boolean).join("\n");
  return (
    <section id="ads">
      <h2 className="mb-1 text-sm font-semibold">Ads · {periodLabel}</h2>
      <p className="mb-2 text-xs text-muted">
        Source: Cortana&apos;s per-ad window figures. Active ads first, then 7-day spend. Fatigue is always judged on 7 days against all-time.
        {scopedNames.length > 0 ? ` Ad-level data is not available for: ${scopedNames.join(", ")}.` : ""}
        {truncatedAt ? ` Showing the first ${truncatedAt} ads; pick a clinic to see all of its ads.` : ""}
      </p>
      {unavailable ? (
        <p className="rounded border border-line bg-panel px-4 py-6 text-sm text-stale">{unavailable}</p>
      ) : rows.length === 0 ? (
        <p className="rounded border border-line bg-panel px-4 py-6 text-sm text-muted">No ad rows loaded from Cortana.</p>
      ) : (
        <div className="overflow-x-auto rounded border border-line bg-panel">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                {showClinic ? <th className={th}>Clinic</th> : null}
                <th className={th}>Ad</th>
                <th className={th}>Status</th>
                {["Spend", "Leads", "Bookings", "Cost per booked", "Frequency", "CTR"].map((c) => <th key={c} className={`${th} text-right`}>{c}</th>)}
                <th className={th} title={fatigueRule}>Fatigue (7d)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.client_id}:${r.ad_id}`} className="border-b border-line last:border-0">
                  {showClinic ? <td className={`${td} text-muted`}>{r.client_name}</td> : null}
                  <td className="max-w-80 truncate px-3 py-1.5" title={`${r.ad_name ?? ""} (${r.ad_id})`}>{r.ad_name ?? r.ad_id}</td>
                  <td className={`${td} text-xs ${STATUS[r.ad_status ?? ""] ?? "text-muted"}`}>{r.ad_status ?? <NoData />}</td>
                  <Num value={r.spend} kind="money" />
                  <Num value={r.leads} kind="count" />
                  <Num value={r.booked} kind="count" />
                  <Num value={r.cost_per_booked} kind="money" />
                  <Num value={r.frequency} kind="times" />
                  <Num value={r.ctr} kind="pct_points" />
                  <td className={td} title={r.fatigue_reason ? `${r.fatigue_reason}\n${fatigueRule}` : fatigueRule}>
                    {r.fatigue === null ? <NoData /> : r.fatigue ? <span className="rounded bg-warn-bg px-1.5 py-0.5 text-xs font-medium text-warn">fatigued</span> : <span className="text-xs text-muted">ok</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
