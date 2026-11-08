import Link from "next/link";
import { resetRenewal, saveRenewal } from "@/lib/actions/renewals";
import { requireOwner } from "@/lib/auth/staff";
import { formatValue } from "@/lib/format";
import { getClientChoices, getRenewals, type RenewalClient, type RenewalState, type RenewalSub, type RenewalWindow } from "@/lib/queries/renewals";
import { etToday } from "@/lib/time";

// Display only. Every figure is computed in SQL (0074_renewals.sql).

const STATE: Record<RenewalState, { label: string; cls: string }> = {
  active: { label: "Active", cls: "bg-good-bg text-good" },
  past_due: { label: "Past due on Whop", cls: "bg-bad-bg text-bad" },
  cancelling: { label: "Cancelling", cls: "bg-warn-bg text-warn" },
  ended: { label: "Ended", cls: "bg-stale-bg text-muted" },
};
const ERRORS: Record<string, string> = {
  invalid: "Check the frequency, date and amount.",
  not_found: "That subscription is no longer there. Reload.",
  save: "The change could not be saved.",
  move: "The subscription could not be moved to that client.",
};

const input = "rounded border border-line px-1.5 py-1";
const button = "cursor-pointer rounded bg-accent px-2 py-1 text-xs font-medium text-white";
const quiet = "cursor-pointer rounded border border-line px-2 py-1 text-xs";
const dash = <span className="text-stale">—</span>;
const money = (v: number | null) => formatValue(v, "money") ?? dash;
const dayLabel = (d: string | null) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }) : null);
const daysUntil = (d: string, today: string) => Math.round((Date.parse(d) - Date.parse(today)) / 86_400_000);

function DueCell({ due, today, state }: { due: string | null; today: string; state?: RenewalState }) {
  if (!due) return dash;
  const n = daysUntil(due, today);
  const when = n < 0 ? `${-n}d overdue` : n === 0 ? "today" : `in ${n}d`;
  const tone = state === "ended" ? "text-muted" : n < 0 ? "font-semibold text-bad" : n <= 7 ? "font-semibold text-warn" : "";
  return <span className={tone}>{dayLabel(due)} <span className="text-xs">({when})</span></span>;
}

const Edited = () => <span className="ml-1 rounded bg-accent/10 px-1 text-[10px] text-accent" title="Your edit, not Whop's">edited</span>;

function SubRow({ s, today, clients, back }: { s: RenewalSub; today: string; clients: { id: string; name: string }[]; back: string }) {
  const edited = s.edit_days !== null || s.edit_amount !== null || s.edit_due !== null;
  return (
    <tr className="border-b border-line text-sm last:border-0">
      <td className="py-1.5 pl-8 pr-3 text-muted">{s.product_title ?? "Untitled plan"}{s.note ? <div className="text-xs italic">{s.note}</div> : null}</td>
      <td className="whitespace-nowrap px-3 py-1.5"><DueCell due={s.next_due} today={today} state={s.state} />{s.edit_due !== null ? <Edited /> : null}
        {s.edit_due_expired ? <div className="text-[11px] text-muted">Whop renewed: your old date was dropped</div> : null}</td>
      <td className="whitespace-nowrap px-3 py-1.5">{s.every_days} days{s.edit_days !== null ? <Edited /> : null}</td>
      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{money(s.amount)}{s.edit_amount !== null ? <Edited /> : null}</td>
      <td className="whitespace-nowrap px-3 py-1.5"><span className={`rounded px-1.5 py-0.5 text-xs ${STATE[s.state].cls}`}>{STATE[s.state].label}</span></td>
      <td colSpan={4} className="px-3 py-1.5">
        <details>
          <summary className="cursor-pointer text-xs text-muted hover:text-ink">Edit</summary>
          <form action={saveRenewal} className="mt-2 flex flex-wrap items-end gap-2 text-xs">
            <input type="hidden" name="membership_id" value={s.membership_id} />
            <input type="hidden" name="back" value={back} />
            <label className="flex flex-col gap-0.5">Client
              <select name="client_id" defaultValue={s.client_id} className={input}>
                {clients.some((c) => c.id === s.client_id) ? null : <option value={s.client_id}>(current)</option>}
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-0.5">Every (days)<input name="every_days" type="number" min={1} max={366} required defaultValue={s.every_days} className={`${input} w-20`} /></label>
            <label className="flex flex-col gap-0.5">Next due<input name="next_due" type="date" required defaultValue={s.next_due ?? ""} className={input} /></label>
            <label className="flex flex-col gap-0.5">Amount ($)<input name="amount" type="number" min={0} step="0.01" required defaultValue={s.amount ?? ""} className={`${input} w-24`} /></label>
            <label className="flex flex-col gap-0.5">Note<input name="note" maxLength={2000} defaultValue={s.note ?? ""} className={`${input} w-48`} /></label>
            <button type="submit" className={button}>Save</button>
            <span className="text-muted">Whop: every {s.whop_days ?? "?"} days, {formatValue(s.whop_amount, "money") ?? "no price"}, due {dayLabel(s.whop_due) ?? "unknown"}</span>
          </form>
          {edited ? (
            <form action={resetRenewal} className="mt-1">
              <input type="hidden" name="membership_id" value={s.membership_id} />
              <input type="hidden" name="back" value={back} />
              <button type="submit" className={quiet}>Back to Whop</button>
            </form>
          ) : null}
        </details>
      </td>
    </tr>
  );
}

function ClientRow({ c, today }: { c: RenewalClient; today: string }) {
  const noFigures = c.no_cortana ? "not connected to Cortana" : c.ads_unverified ? "ad numbers unverified" : null;
  return (
    <tr className="border-b border-t-2 border-line border-t-line bg-canvas">
      <td className="px-3 py-2">
        <Link href={`/clients/${c.client_id}`} className="font-medium underline decoration-line underline-offset-2 hover:decoration-ink">{c.client}</Link>
        {c.stage !== "live" ? <span className="ml-2 text-xs text-muted">{c.stage}</span> : null}
      </td>
      <td className="whitespace-nowrap px-3 py-2"><DueCell due={c.next_due} today={today} /></td>
      <td colSpan={3} />
      {noFigures || c.spend === null ? (
        <td colSpan={4} className="px-3 py-2 text-center text-xs text-stale">{noFigures ?? "no running subscription"}</td>
      ) : (
        <>
          <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{money(c.spend)}</td>
          <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{money(c.revenue)}</td>
          <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{c.roas === null ? dash : `${c.roas.toFixed(1)}x`}</td>
          <td className={`whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums ${(c.profit ?? 0) < 0 ? "text-bad" : "text-good"}`}>{money(c.profit)}</td>
        </>
      )}
    </tr>
  );
}

export default async function RenewalsPage({ searchParams }: PageProps<"/renewals">) {
  await requireOwner();
  const params = await searchParams;
  const window: RenewalWindow = params.window === "launch" ? "launch" : "cycle";
  const showEnded = params.ended === "1";
  const [rows, clients] = await Promise.all([getRenewals(window, showEnded), getClientChoices()]);
  const today = etToday();
  const query = (w: RenewalWindow, e: boolean) => [w === "launch" ? "window=launch" : "", e ? "ended=1" : ""].filter(Boolean).join("&");
  const back = query(window, showEnded);
  const href = (w: RenewalWindow, e: boolean) => `/renewals${query(w, e) ? `?${query(w, e)}` : ""}`;
  const error = typeof params.error === "string" ? ERRORS[params.error] ?? ERRORS.save : null;
  const dueSoon = rows.filter((r) => r.next_due && daysUntil(r.next_due, today) <= 7).length;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Renewals</h1>
          <p className="text-xs text-muted">
            {rows.length} clients · {dueSoon} due within 7 days. Subscriptions from Whop; your edits are kept when Whop syncs.
            Spend and revenue from Cortana, {window === "cycle" ? "this cycle (since the last renewal of the soonest-due subscription)" : "since launch"}.
            Est. profit = revenue − spend − 30% of revenue.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-line">
            {(["cycle", "launch"] as const).map((w) => (
              <Link key={w} href={href(w, showEnded)} className={`px-3 py-1.5 text-xs ${w === window ? "bg-accent font-medium text-white" : "bg-panel text-muted hover:text-ink"}`}>
                {w === "cycle" ? "This cycle" : "Since launch"}
              </Link>
            ))}
          </div>
          <Link href={href(window, !showEnded)} className={quiet}>{showEnded ? "Hide ended" : "Show ended"}</Link>
        </div>
      </div>
      {error ? <p className="rounded border border-bad bg-bad-bg px-3 py-2 text-sm text-bad">{error}</p> : null}
      {params.saved ? <p className="rounded border border-good bg-good-bg px-3 py-2 text-sm text-good">Saved.</p> : null}
      {params.reset ? <p className="rounded border border-good bg-good-bg px-3 py-2 text-sm text-good">Back to Whop&apos;s values.</p> : null}

      <div className="overflow-x-auto rounded-lg border border-line bg-panel">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-normal">Client / plan</th>
              <th className="px-3 py-2 font-normal">Next due</th>
              <th className="px-3 py-2 font-normal">Every</th>
              <th className="px-3 py-2 text-right font-normal">Amount</th>
              <th className="px-3 py-2 font-normal">Status</th>
              <th className="px-3 py-2 text-right font-normal">Ad spend</th>
              <th className="px-3 py-2 text-right font-normal">Revenue</th>
              <th className="px-3 py-2 text-right font-normal">ROAS</th>
              <th className="px-3 py-2 text-right font-normal">Est. profit</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? <tr><td colSpan={9} className="px-3 py-6 text-center text-muted">No subscriptions linked to a client.</td></tr> : null}
            {rows.map((c) => [
              <ClientRow key={c.client_id} c={c} today={today} />,
              ...c.subs.map((s) => <SubRow key={s.membership_id} s={s} today={today} clients={clients} back={back} />),
            ])}
          </tbody>
        </table>
      </div>
    </div>
  );
}
