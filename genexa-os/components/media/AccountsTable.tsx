import Link from "next/link";
import type { AccountRow, Thresholds } from "@/lib/queries/media";
import { NoData, Num, PILL, show, td, th } from "./Cells";

const COLUMNS = [
  "Spend", "CPL", "Cost per booked", "Booking rate", "Cost per show", "Cost per close", "Frequency (approx.)", "CTR", "CPM", "Days live", "SOP stage", "Verdict (7d)",
];
const VERDICT: Record<string, string> = { green: "On target", amber: "Watch", red: "Over" };

/** One row per connected clinic for the chosen window. The verdict is always the 7-day cost per booked. */
export function AccountsTable({
  rows, notConnected, thresholds, clinicHref, selected,
}: {
  rows: AccountRow[]; notConnected: { id: string; name: string; stage: string }[]; thresholds: Thresholds;
  clinicHref: (clientId: string) => string; selected: string | null;
}) {
  const sop = ["sop_milestone_1", "sop_milestone_2", "sop_milestone_3", "sop_milestone_4"].map((k) => thresholds[k]).filter(Boolean).join("\n");
  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold">Accounts</h2>
      <p className="mb-2 text-xs text-muted">
        Source: Cortana. Ratios are worked out from the window&apos;s totals. Frequency is impressions ÷ summed daily reach, so it is approximate.
        Click a clinic for its daily rows.
      </p>
      {rows.length === 0 ? (
        <p className="rounded border border-line bg-panel px-4 py-6 text-sm text-muted">No clinic is connected to Cortana.</p>
      ) : (
        <div className="overflow-x-auto rounded border border-line bg-panel">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th className={th}>Clinic</th>
                {COLUMNS.map((c) => (
                  <th key={c} className={`${th} ${c === "SOP stage" || c === "Verdict (7d)" ? "" : "text-right"}`} title={c === "SOP stage" ? sop : c === "Verdict (7d)" ? thresholds.cost_per_booked_7d : undefined}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.client_id} className={`border-b border-line last:border-0 ${selected === r.client_id ? "bg-raised" : ""}`}>
                  <td className={td}>
                    <Link href={clinicHref(r.client_id)} className="underline decoration-line underline-offset-2 hover:decoration-muted">{r.name}</Link>
                    {r.stage !== "live" ? <span className="ml-2 text-xs text-muted">{r.stage}</span> : null}
                  </td>
                  {r.unverified ? (
                    <td colSpan={COLUMNS.length} className={`${td} text-stale`}>
                      <span className="rounded bg-stale-bg px-1.5 py-0.5 text-xs">unverified</span>
                      <span className="ml-2 text-xs">Cortana business not confirmed: left out of every number</span>
                    </td>
                  ) : (
                    <>
                      <td className={`${td} text-right`}>
                        {r.spend === null ? <NoData /> : (
                          <Link href="/drill/ad_spend?period=month" title="Daily ad spend rows, every clinic, this month" className="hover:underline">
                            {show(r.spend, "money")}
                          </Link>
                        )}
                      </td>
                      <Num value={r.cpl} kind="money" />
                      <td className={`${td} text-right`}>
                        {r.cost_per_booked === null ? <NoData /> : (
                          <Link href="/drill/cost_per_booked?period=month" title="Daily spend and bookings, every clinic, this month" className="hover:underline">
                            {show(r.cost_per_booked, "money")}
                          </Link>
                        )}
                      </td>
                      <Num value={r.booking_rate} kind="percent" />
                      <Num value={r.cost_per_show} kind="money" />
                      <Num value={r.cost_per_close} kind="money" />
                      <Num value={r.frequency} kind="times" />
                      <Num value={r.ctr} kind="pct_points" />
                      <Num value={r.cpm} kind="money" />
                      <Num value={r.days_live} kind="count" />
                      <td className={td} title={sop}>{r.sop_stage ?? <NoData />}</td>
                      <td className={td} title={thresholds.cost_per_booked_7d}>
                        {r.verdict ? (
                          <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${PILL[r.verdict]}`}>
                            {VERDICT[r.verdict]} · {show(r.cost_per_booked_7d, "money")}
                          </span>
                        ) : (
                          <NoData text={r.verdict_note ?? "no data"} />
                        )}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {notConnected.length > 0 ? (
        <p className="mt-2 text-xs text-muted">
          Not connected to Cortana (no numbers):{" "}
          {notConnected.map((c, i) => (
            <span key={c.id}>
              {i > 0 ? ", " : ""}
              <Link href={`/clients/${c.id}`} className="underline decoration-line underline-offset-2">{c.name}</Link>
              {c.stage !== "live" ? ` (${c.stage})` : ""}
            </span>
          ))}
        </p>
      ) : null}
    </section>
  );
}
