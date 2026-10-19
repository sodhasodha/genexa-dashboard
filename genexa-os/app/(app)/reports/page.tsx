import Link from "next/link";
import { requireStaff } from "@/lib/auth/staff";
import { formatValue } from "@/lib/format";
import { getReports, parseReportRange, presetRange, type ReportStatus } from "@/lib/queries/reports";
import { rangeLabel } from "@/lib/reports/pdf";
import { etToday } from "@/lib/time";

const STATUS: Record<ReportStatus, { label: string; tone: string }> = {
  good: { label: "Good", tone: "bg-good-bg text-good" },
  check: { label: "Check", tone: "bg-warn-bg text-warn" },
  dont_send: { label: "Don't send", tone: "bg-bad-bg text-bad" },
};

export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  await requireStaff();
  const today = etToday();
  const range = parseReportRange(await searchParams, today);
  const rows = await getReports(range);
  const q = `from=${range.from}&to=${range.to}`;
  const money = (v: number | null) => formatValue(v, "money") ?? <span className="text-stale">—</span>;
  const tab = (active: boolean) => `px-3 py-1.5 text-xs ${active ? "bg-accent font-medium text-white" : "bg-panel text-muted hover:text-ink"}`;
  const last30 = presetRange("last_30", today);
  const counts = { good: rows.filter((r) => r.status === "good").length, check: rows.filter((r) => r.status === "check").length, dont: rows.filter((r) => r.status === "dont_send").length };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Reports</h1>
          <p className="text-xs text-muted">
            {rangeLabel(range.from, range.to)} · {counts.good} good, {counts.check} to check, {counts.dont} not to send. Figures from Cortana, days in ET.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex overflow-hidden rounded-md border border-line">
            <Link href={`/reports?from=${last30.from}&to=${last30.to}`} className={tab(range.preset === "last_30")}>Last 30 days</Link>
            <Link href="/reports?preset=last_month" className={tab(range.preset === "last_month")}>Last calendar month</Link>
          </div>
          <form method="get" action="/reports" className="flex items-end gap-2 text-xs text-muted">
            <label className="flex flex-col gap-1">From<input type="date" name="from" defaultValue={range.from} min="2026-08-01" max={today} className="rounded border border-line bg-raised px-2 py-1 text-sm" /></label>
            <label className="flex flex-col gap-1">To<input type="date" name="to" defaultValue={range.to} min="2026-08-01" max={today} className="rounded border border-line bg-raised px-2 py-1 text-sm" /></label>
            <button className="cursor-pointer rounded bg-accent px-3 py-1.5 text-xs font-medium text-white">Show</button>
          </form>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line bg-panel">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-normal">Clinic</th>
              <th className="px-3 py-2 text-right font-normal">Ad spend</th>
              <th className="px-3 py-2 text-right font-normal">Appointments booked</th>
              <th className="px-3 py-2 text-right font-normal">Shows</th>
              <th className="px-3 py-2 text-right font-normal">Closes</th>
              <th className="px-3 py-2 text-right font-normal">Revenue</th>
              <th className="px-3 py-2 text-right font-normal">ROAS</th>
              <th className="px-3 py-2 font-normal">Status</th>
              <th className="px-3 py-2 font-normal"><span className="sr-only">PDF</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-muted">No live clinics.</td></tr>
            ) : rows.map((r) => (
              <tr key={r.client_id} className={`border-b border-line align-top last:border-0 ${r.roas_bad ? "bg-bad-bg" : ""}`}>
                <td className="whitespace-nowrap px-3 py-2 font-medium">
                  <Link href={`/clients/${r.client_id}`} className="underline decoration-line underline-offset-2 hover:decoration-ink">{r.name}</Link>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{money(r.spend)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{r.booked}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{r.shows}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{r.closes}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{money(r.revenue)}</td>
                <td className={`whitespace-nowrap px-3 py-2 text-right tabular-nums ${r.roas_bad ? "font-bold text-bad" : ""}`}>{r.roas === null ? <span className="text-stale">—</span> : `${r.roas.toFixed(1)}x`}</td>
                <td className="px-3 py-2">
                  <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[r.status].tone}`}>{STATUS[r.status].label}</span>
                  {r.reasons.length > 0 ? <ul className="mt-1 list-disc pl-4 text-xs text-muted">{r.reasons.map((x) => <li key={x}>{x}</li>)}</ul> : null}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  <a href={`/api/reports/${r.client_id}/pdf?${q}`} target="_blank" rel="noreferrer" className="rounded border border-line bg-raised px-2 py-1 text-xs hover:border-muted">Generate PDF</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">
        Don&apos;t send: numbers missing or not trustworthy for this range (not connected to Cortana, unverified, no ad spend, or Cortana not synced).
        Check: real numbers, but something reads badly or is incomplete (range includes today, launched mid-range, outcomes or close amounts not logged, ROAS under 3x). Rows in red have ROAS under 3x.
        The PDF carries only the clinic name, dates, ad spend, appointments, revenue, ROAS and the patient funnel.
      </p>
    </div>
  );
}
