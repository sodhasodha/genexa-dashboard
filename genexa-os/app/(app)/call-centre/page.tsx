import Link from "next/link";
import { requireStaff } from "@/lib/auth/staff";
import { formatValue } from "@/lib/format";
import { getCallCentre } from "@/lib/queries/confirmations";
import { addDays, etToday } from "@/lib/time";

const PERIODS = [
  { key: "today", label: "Today", days: 0 },
  { key: "7d", label: "Last 7 days", days: 6 },
  { key: "30d", label: "Last 30 days", days: 29 },
] as const;

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((100 * part) / whole)}%` : "—");
const mins = (m: number | null) => (m === null ? "—" : m < 60 ? `${Math.round(m)}m` : `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`);

/** How the CSRs are doing on the confirmation desk. Every number comes from the calls they log there. */
export default async function CallCentrePage({ searchParams }: PageProps<"/call-centre">) {
  const me = await requireStaff();
  const params = await searchParams;
  const period = PERIODS.find((p) => p.key === params.period) ?? PERIODS[1];
  const to = etToday();
  const from = addDays(to, -period.days);
  const { people, totals } = await getCallCentre(from, to);
  const th = "px-3 py-2 font-normal";
  const td = "whitespace-nowrap px-3 py-2 text-right tabular-nums";

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Call Centre</h1>
          <p className="text-xs text-muted">
            From the confirmation desk: every call the CSRs log on {me.role === "owner" ? <Link href="/confirmations" className="underline">/confirmations</Link> : "/confirmations"}. {from === to ? from : `${from} to ${to}`} (ET).
          </p>
        </div>
        <div className="flex overflow-hidden rounded-md border border-line">
          {PERIODS.map((p) => (
            <Link key={p.key} href={`/call-centre?period=${p.key}`} className={`px-3 py-1.5 text-xs ${p.key === period.key ? "bg-accent font-medium text-white" : "bg-panel text-muted hover:text-ink"}`}>{p.label}</Link>
          ))}
        </div>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Per CSR</h2>
        <div className="overflow-x-auto rounded-lg border border-line bg-panel">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th className={th}>CSR</th>
                <th className={`${th} text-right`}>Calls</th>
                <th className={`${th} text-right`}>Patients called</th>
                <th className={`${th} text-right`}>Confirmed</th>
                <th className={`${th} text-right`} title="Confirmed ÷ patients called">Confirm rate</th>
                <th className={`${th} text-right`}>No answer</th>
                <th className={`${th} text-right`}>Voicemail</th>
                <th className={`${th} text-right`}>Rescheduled</th>
                <th className={`${th} text-right`} title="Patients who reached 10 calls without an answer">Unreachable</th>
                <th className={`${th} text-right`} title="From the appointment reaching the desk to the first call">Time to first call</th>
              </tr>
            </thead>
            <tbody>
              {people.length === 0 ? (
                <tr><td colSpan={10} className="px-3 py-6 text-center text-muted">No calls logged in this period.</td></tr>
              ) : people.map((p) => (
                <tr key={p.staff_id} className="border-b border-line last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 font-medium">{p.name}</td>
                  <td className={td}>{p.calls}</td>
                  <td className={td}>{p.appointments}</td>
                  <td className={`${td} text-good`}>{p.confirmed}</td>
                  <td className={td}>{pct(p.confirmed, p.appointments)}</td>
                  <td className={td}>{p.no_answer}</td>
                  <td className={td}>{p.voicemail}</td>
                  <td className={td}>{p.rescheduled}</td>
                  <td className={td}>{p.unreachable}</td>
                  <td className={td}>{mins(p.first_call_minutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {totals ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold">The desk (appointments on it during this period)</h2>
          <div className="flex flex-wrap gap-2 text-sm">
            {[
              { label: "Reached the desk", value: totals.appointments },
              { label: "Called at least once", value: totals.called, sub: pct(totals.called, totals.appointments) },
              { label: "Confirmed", value: totals.confirmed, sub: pct(totals.confirmed, totals.appointments), tone: "text-good" },
              { label: "Rescheduled", value: totals.rescheduled },
              { label: "Cancelled", value: totals.cancelled },
              { label: "Unreachable", value: totals.unreachable },
              { label: "Expired - unconfirmed", value: totals.expired, tone: totals.expired > 0 ? "text-bad" : "" },
              { label: "Still open", value: totals.open },
            ].map((t) => (
              <div key={t.label} className="rounded-md border border-line bg-panel px-3 py-2">
                <p className="text-xs text-muted">{t.label}</p>
                <p className={`text-lg font-semibold tabular-nums ${t.tone ?? ""}`}>{formatValue(t.value, "count")}{t.sub ? <span className="ml-1.5 text-xs font-normal text-muted">{t.sub}</span> : null}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
