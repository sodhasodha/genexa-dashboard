import Link from "next/link";
import type { ClinicDaily as ClinicDailyData } from "@/lib/queries/media";
import { Num, td, th } from "./Cells";

/** One clinic's daily rows for the window: the rows its account line adds up from. */
export function ClinicDaily({ name, windowLabel, daily, closeHref, unverified }: { name: string; windowLabel: string; daily: ClinicDailyData; closeHref: string; unverified: boolean }) {
  return (
    <section id="daily">
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold">{name} · daily rows · {windowLabel}</h2>
        <span className="text-xs text-muted">{daily.from && daily.to ? `${daily.from} to ${daily.to} (ET)` : null}</span>
        <Link href={closeHref} className="ml-auto text-xs text-muted underline">All clinics</Link>
      </div>
      {unverified ? (
        <p className="rounded border border-line bg-panel px-4 py-6 text-sm text-stale">Unverified: this clinic&apos;s Cortana business is not confirmed, so its rows are left out of every number.</p>
      ) : daily.rows.length === 0 ? (
        <p className="rounded border border-line bg-panel px-4 py-6 text-sm text-muted">No rows loaded from Cortana for these days.</p>
      ) : (
        <div className="overflow-x-auto rounded border border-line bg-panel">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th className={th}>Day (ET)</th>
                {["Spend", "Leads", "Booked", "Shows", "Closes", "Revenue"].map((c) => <th key={c} className={`${th} text-right`}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {[...daily.rows, ...(daily.total ? [daily.total] : [])].map((r) => (
                <tr key={r.day} className={`border-b border-line last:border-0 ${r.day === "Total" ? "bg-raised font-medium" : ""}`}>
                  <td className={td}>{r.day}</td>
                  <Num value={r.spend} kind="money" />
                  <Num value={r.leads} kind="count" />
                  <Num value={r.booked} kind="count" />
                  <Num value={r.shows} kind="count" />
                  <Num value={r.closes} kind="count" />
                  <Num value={r.revenue} kind="money" />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
