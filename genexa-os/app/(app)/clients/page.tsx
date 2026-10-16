import Link from "next/link";
import { DominationMap } from "@/components/DominationMap";
import { requireStaff } from "@/lib/auth/staff";
import { formatValue } from "@/lib/format";
import { HEALTH_WINDOWS, getCortanaFreshness, getHealthBoard } from "@/lib/queries/clients";
import { getDominationData } from "@/lib/queries/domination";

const TONE: Record<string, string> = { red: "bg-bad", amber: "bg-warn", green: "bg-good", grey: "bg-stale" };
const TEXT: Record<string, string> = { red: "text-bad", amber: "text-warn", green: "text-good", grey: "text-stale" };
const NOT_ADS: Record<string, string> = { not_connected: "not connected to Cortana", unverified: "ad numbers unverified" };

export default async function ClientsPage({ searchParams }: PageProps<"/clients">) {
  const staff = await requireStaff();
  const params = await searchParams;
  const days = HEALTH_WINDOWS.find((w) => String(w.days) === params.days)?.days ?? 7;
  const [rows, domination, cortana] = await Promise.all([getHealthBoard(days), getDominationData(), getCortanaFreshness()]);
  const range = rows.find((r) => r.window_from && r.window_to);
  const money = (v: number | null) => formatValue(v, "money") ?? <span className="text-stale">—</span>;
  const counts = { red: rows.filter((r) => r.colour === "red").length, amber: rows.filter((r) => r.colour === "amber").length, green: rows.filter((r) => r.colour === "green").length };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Clients</h1>
          <p className="text-xs text-muted">
            {counts.red} red · {counts.amber} amber · {counts.green} green. Worst first. Numbers are {HEALTH_WINDOWS.find((w) => w.days === days)?.label.toLowerCase()}
            {range ? ` (${range.window_from} to ${range.window_to})` : ""}, complete days, from Cortana{cortana ? ` (last read ${cortana})` : ""}. Full detail is on <Link href="/media-buying#clinic-detail" className="underline">Media Buying</Link>.
          </p>
        </div>
        <div className="flex overflow-hidden rounded-md border border-line">
          {HEALTH_WINDOWS.map((w) => (
            <Link key={w.days} href={w.days === 7 ? "/clients" : `/clients?days=${w.days}`}
              className={`px-3 py-1.5 text-xs ${w.days === days ? "bg-accent font-medium text-white" : "bg-panel text-muted hover:text-ink"}`}>
              {w.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line bg-panel">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-normal">Clinic</th>
              <th className="px-3 py-2 font-normal">Main bottleneck</th>
              <th className="px-3 py-2 text-right font-normal" title="This calendar month so far, from Cortana">MTD revenue</th>
              <th className="px-3 py-2 text-right font-normal">Ad spend</th>
              <th className="px-3 py-2 text-right font-normal">ROAS</th>
              <th className="px-3 py-2 text-right font-normal">CPL</th>
              <th className="px-3 py-2 text-right font-normal">Cost / appt</th>
              <th className="px-3 py-2 text-right font-normal">Cost / close</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const colour = r.colour ?? "grey";
              return (
                <tr key={r.client_id} className="border-b border-line last:border-0">
                  <td className="whitespace-nowrap px-3 py-2">
                    <span className={`mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle ${TONE[colour] ?? TONE.grey}`} />
                    <Link href={`/clients/${r.client_id}`} className="font-medium underline decoration-line underline-offset-2 hover:decoration-ink">{r.name}</Link>
                    {r.stage !== "live" ? <span className="ml-2 text-xs text-muted">{r.stage}</span> : null}
                  </td>
                  <td className={`max-w-md truncate px-3 py-2 ${r.bottleneck ? TEXT[colour] ?? "" : "text-muted"}`} title={r.reasons ?? undefined}>
                    {r.bottleneck ?? "On track"}
                  </td>
                  {r.ads_state === "ok" ? (
                    <>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">{money(r.mtd_revenue)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{money(r.spend)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{r.roas === null ? <span className="text-stale">—</span> : `${r.roas.toFixed(2)}x`}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{money(r.cpl)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{money(r.cost_per_booked)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{money(r.cost_per_close)}</td>
                    </>
                  ) : (
                    <td colSpan={6} className="px-3 py-2 text-center text-xs text-stale">{NOT_ADS[r.ads_state]}</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">Hover a bottleneck for every reason. MTD revenue is this calendar month so far; the other columns follow the window above. ROAS is clinic revenue over ad spend in the window. A dash means nothing to divide by (no spend, leads, appointments or closes in the window).</p>

      <DominationMap data={domination} canEdit={staff.role === "owner"} monthLabel="MTD" />
    </div>
  );
}
