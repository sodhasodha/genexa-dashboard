import Link from "next/link";
import { requireStaff } from "@/lib/auth/staff";
import { formatValue, type Unit } from "@/lib/format";
import {
  LANES, PODS, STAGES, getClientLanes, getClientList, parseClientListParams,
  type ClientListParams, type ClientListRow, type ClientLanesRow, type Lane, type SortKey,
} from "@/lib/queries/clients";

const NO_DATA = <span className="text-stale">no data</span>;
const POD = (p: string | null) => (p ? p.replace("pod_", "Pod ") : null);
const MONTH_LABEL = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const TONE: Record<string, string> = {
  red: "bg-bad-bg text-bad", amber: "bg-warn-bg text-warn", green: "bg-good-bg text-good", grey: "bg-stale-bg text-stale",
};
const RENEWAL_TONE: Record<string, string> = {
  overdue: "text-bad", due_7d: "text-warn", cancelling: "text-bad", paid: "text-good", upcoming: "text-muted", not_started: "text-muted",
};
const LANE_LABEL: Record<Lane, string> = { launch: "Launch", ads: "Ads", call_centre: "Call centre", outcomes: "Outcomes", contact: "Contact" };
const ADS_STATE_LABEL = { not_connected: "not connected", unverified: "unverified" } as const;

type MonthColumn = { key: SortKey & keyof ClientListRow; label: string; unit: Unit | "ratio" };
const MONTH_COLUMNS: MonthColumn[] = [
  { key: "spend", label: "Spend", unit: "money" }, { key: "leads", label: "Leads", unit: "count" },
  { key: "booked", label: "Booked", unit: "count" }, { key: "confirmed", label: "Confirmed", unit: "count" },
  { key: "shows", label: "Shows", unit: "count" }, { key: "closes", label: "Closes", unit: "count" },
  { key: "revenue", label: "Revenue", unit: "money" }, { key: "cpl", label: "CPL", unit: "money" },
  { key: "cost_per_booked", label: "Cost / booked", unit: "money" }, { key: "booking_rate", label: "Booking rate", unit: "percent" },
  { key: "confirmation_rate", label: "Confirm rate", unit: "percent" }, { key: "show_rate", label: "Show rate", unit: "percent" },
  { key: "close_rate", label: "Close rate", unit: "percent" }, { key: "ctr", label: "CTR", unit: "percent" },
  { key: "roas", label: "ROAS", unit: "ratio" },
];
const show = (value: number | null, unit: Unit | "ratio") =>
  (unit === "ratio" ? (value === null ? null : `${value.toFixed(2)}x`) : formatValue(value, unit)) ?? NO_DATA;

/** Query string for this page with some values changed. Defaults are left out. */
function href(p: ClientListParams, change: Partial<Pick<ClientListParams, "view" | "sort" | "dir">> = {}): string {
  const next = { ...p, ...change };
  const q = new URLSearchParams();
  if (next.view === "lanes") q.set("view", "lanes");
  if (next.month !== p.months[0]) q.set("month", next.month);
  if (next.stage) q.set("stage", next.stage);
  if (next.pod) q.set("pod", next.pod);
  if (next.sort !== "name" || next.dir !== "asc") {
    q.set("sort", next.sort);
    q.set("dir", next.dir);
  }
  const s = q.toString();
  return s ? `/clients?${s}` : "/clients";
}

function SortHeader({ p, sort, label, right }: { p: ClientListParams; sort: SortKey; label: string; right?: boolean }) {
  const active = p.sort === sort;
  const dir = active && p.dir === "asc" ? "desc" : "asc";
  return (
    <th className={`whitespace-nowrap px-3 py-2 font-normal ${right ? "text-right" : ""}`} aria-sort={active ? (p.dir === "asc" ? "ascending" : "descending") : undefined}>
      <Link href={href(p, { sort, dir })} className={active ? "font-semibold text-ink" : "hover:text-ink"}>
        {label}{active ? (p.dir === "asc" ? " ↑" : " ↓") : ""}
      </Link>
    </th>
  );
}

function ListTable({ rows, p }: { rows: ClientListRow[]; p: ClientListParams }) {
  if (rows.length === 0) return <p className="rounded border border-line bg-panel px-4 py-6 text-sm text-muted">No clients match.</p>;
  return (
    <div className="overflow-x-auto rounded border border-line bg-panel">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line text-xs text-muted">
          <tr>
            <SortHeader p={p} sort="name" label="Clinic" />
            <SortHeader p={p} sort="stage" label="Stage" />
            <SortHeader p={p} sort="pod" label="Pod" />
            <SortHeader p={p} sort="health" label="Health" />
            <SortHeader p={p} sort="days_live" label="Days live" right />
            <SortHeader p={p} sort="monthly_fee" label="Monthly fee" right />
            <SortHeader p={p} sort="renewal" label="Next renewal" />
            <SortHeader p={p} sort="guarantee" label="Guarantee" />
            {MONTH_COLUMNS.map((c) => <SortHeader key={c.key} p={p} sort={c.key} label={c.label} right />)}
            <SortHeader p={p} sort="last_contact_us" label="Last contact (us)" />
            <SortHeader p={p} sort="last_reply_client" label="Last reply (client)" />
            <SortHeader p={p} sort="next_action" label="Next action" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.client_id} className={`border-b border-line last:border-0 ${r.churned ? "opacity-50" : ""}`}>
              <td className="whitespace-nowrap px-3 py-1.5 font-medium">
                <Link href={`/clients/${r.client_id}`} className="underline decoration-line underline-offset-2 hover:decoration-ink">{r.name}</Link>
              </td>
              <td className="whitespace-nowrap px-3 py-1.5">{r.stage}</td>
              <td className="whitespace-nowrap px-3 py-1.5">{POD(r.pod) ?? NO_DATA}</td>
              <td className="whitespace-nowrap px-3 py-1.5">
                {r.health_colour ? (
                  <span title={r.health_reasons ?? "No issues found"} className={`rounded-full px-2 py-0.5 text-xs ${TONE[r.health_colour] ?? TONE.grey}`}>{r.health_colour}</span>
                ) : (
                  <span title="Churned clients are not scored" className={`rounded-full px-2 py-0.5 text-xs ${TONE.grey}`}>not scored</span>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{formatValue(r.days_live, "count") ?? NO_DATA}</td>
              <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{formatValue(r.monthly_fee, "money") ?? NO_DATA}</td>
              <td className="whitespace-nowrap px-3 py-1.5">
                {r.renewal_date ?? (r.renewal_status ? null : NO_DATA)}
                {r.renewal_status ? <span className={`${r.renewal_date ? "ml-1.5" : ""} text-xs ${RENEWAL_TONE[r.renewal_status] ?? "text-muted"}`}>{r.renewal_status.replace("_", " ")}</span> : null}
              </td>
              <td className="max-w-56 truncate px-3 py-1.5" title={r.guarantee_text ?? undefined}>
                {r.guarantee_text ?? (r.guarantee_deadline ? null : NO_DATA)}
                {r.guarantee_deadline ? <span className="ml-1.5 text-xs text-muted">due {r.guarantee_deadline}</span> : null}
              </td>
              {r.ads_state === "ok" ? (
                MONTH_COLUMNS.map((c) => <td key={c.key} className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{show(r[c.key] as number | null, c.unit)}</td>)
              ) : (
                <td colSpan={MONTH_COLUMNS.length} className="whitespace-nowrap px-3 py-1.5 text-center text-xs text-stale">{ADS_STATE_LABEL[r.ads_state]}</td>
              )}
              <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">{r.last_contact_us ?? NO_DATA}</td>
              <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">{r.last_reply_client ?? NO_DATA}</td>
              <td className="max-w-72 truncate px-3 py-1.5" title={r.next_action ?? undefined}>{r.next_action ?? NO_DATA}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LanesTable({ rows }: { rows: ClientLanesRow[] }) {
  if (rows.length === 0) return <p className="rounded border border-line bg-panel px-4 py-6 text-sm text-muted">No clients match.</p>;
  return (
    <div className="overflow-x-auto rounded border border-line bg-panel">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line text-xs text-muted">
          <tr>
            <th className="px-3 py-2 font-normal">Clinic</th>
            <th className="px-3 py-2 font-normal">Stage</th>
            {LANES.map((l) => <th key={l} className="px-3 py-2 font-normal">{LANE_LABEL[l]}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.client_id} className={`border-b border-line last:border-0 ${r.stage === "churned" ? "opacity-50" : ""}`}>
              <td className="whitespace-nowrap px-3 py-1.5 font-medium">
                <Link href={`/clients/${r.client_id}`} className="underline decoration-line underline-offset-2 hover:decoration-ink">{r.name}</Link>
              </td>
              <td className="whitespace-nowrap px-3 py-1.5">{r.stage}</td>
              {LANES.map((l) => {
                const cell = r.lanes[l];
                return (
                  <td key={l} className="px-1.5 py-1.5">
                    {cell ? (
                      <span title={cell.reason} className={`block min-w-24 truncate rounded px-2 py-1 text-xs ${TONE[cell.colour] ?? TONE.grey}`}>
                        {cell.colour === "green" ? "OK" : cell.reason}
                      </span>
                    ) : NO_DATA}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function ClientsPage({ searchParams }: PageProps<"/clients">) {
  await requireStaff();
  const p = parseClientListParams(await searchParams);
  const [list, lanes] = await Promise.all([
    p.view === "list" ? getClientList(p) : Promise.resolve(null),
    p.view === "lanes" ? getClientLanes(p) : Promise.resolve(null),
  ]);
  const select = "rounded border border-line bg-raised px-2 py-1 text-sm";
  const tab = (active: boolean) => `rounded px-2.5 py-1 text-sm ${active ? "bg-accent text-white" : "border border-line text-muted hover:text-ink"}`;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Clients</h1>
          <p className="text-xs text-muted">
            {p.view === "list"
              ? `Monthly numbers are for ${MONTH_LABEL(p.month)} (ET), from Cortana. Hover a health pill for the reasons.`
              : "One cell per lane. Hover a cell for the full reason. Grey means there is nothing to judge that lane on."}
          </p>
        </div>
        <div className="flex gap-1.5">
          <Link href={href(p, { view: "list" })} className={tab(p.view === "list")}>List</Link>
          <Link href={href(p, { view: "lanes" })} className={tab(p.view === "lanes")}>Lanes</Link>
        </div>
      </div>

      <form method="get" action="/clients" className="flex flex-wrap items-end gap-3 text-xs text-muted">
        {p.view === "lanes" ? <input type="hidden" name="view" value="lanes" /> : null}
        {p.sort !== "name" || p.dir !== "asc" ? (
          <>
            <input type="hidden" name="sort" value={p.sort} />
            <input type="hidden" name="dir" value={p.dir} />
          </>
        ) : null}
        {p.view === "list" ? (
          <label className="flex flex-col gap-1">
            Month
            <select name="month" defaultValue={p.month} className={select}>
              {p.months.map((m) => <option key={m} value={m}>{MONTH_LABEL(m)}</option>)}
            </select>
          </label>
        ) : null}
        <label className="flex flex-col gap-1">
          Stage
          <select name="stage" defaultValue={p.stage ?? ""} className={select}>
            <option value="">All stages</option>
            {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Pod
          <select name="pod" defaultValue={p.pod ?? ""} className={select}>
            <option value="">All pods</option>
            {PODS.map((pod) => <option key={pod} value={pod}>{POD(pod)}</option>)}
          </select>
        </label>
        <button type="submit" className="cursor-pointer rounded bg-accent px-3 py-1.5 text-xs font-medium text-white">Apply</button>
      </form>

      {list ? <ListTable rows={list} p={p} /> : null}
      {lanes ? <LanesTable rows={lanes} /> : null}
    </div>
  );
}
