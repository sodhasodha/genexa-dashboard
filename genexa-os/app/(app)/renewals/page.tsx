import Link from "next/link";
import { addPlan, removePlan, renewPlan, savePlan } from "@/lib/actions/renewals";
import { requireOwner } from "@/lib/auth/staff";
import { formatValue } from "@/lib/format";
import { getClientChoices, getRenewals, type RenewalClient, type RenewalPlan, type RenewalStatus, type RenewalWindow } from "@/lib/queries/renewals";
import { addDays, etToday } from "@/lib/time";

// Display only. Subscriptions are kept by hand (not synced to Whop); figures are computed in SQL (0075_renewal_plans.sql).

const STATUS: Record<RenewalStatus, { label: string; cls: string }> = {
  active: { label: "Active", cls: "bg-good-bg text-good" },
  past_due: { label: "Past due", cls: "bg-bad-bg text-bad" },
  cancelling: { label: "Cancelling", cls: "bg-warn-bg text-warn" },
  ended: { label: "Ended", cls: "bg-stale-bg text-muted" },
};
const SAVED: Record<string, string> = { added: "Subscription added.", saved: "Saved.", renewed: "Marked renewed: next due moved on one cycle.", removed: "Subscription removed." };
const ERRORS: Record<string, string> = { invalid: "Check the client, name, frequency, amount and date.", save: "That could not be saved. Reload and try again." };

const input = "rounded border border-line px-1.5 py-1";
const button = "cursor-pointer rounded bg-accent px-2 py-1 text-xs font-medium text-white";
const quiet = "cursor-pointer rounded border border-line px-2 py-1 text-xs";
const dash = <span className="text-stale">—</span>;
const money = (v: number | null) => formatValue(v, "money") ?? dash;
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const daysUntil = (d: string, today: string) => Math.round((Date.parse(d) - Date.parse(today)) / 86_400_000);

function DueCell({ due, today, ended }: { due: string | null; today: string; ended?: boolean }) {
  if (!due) return dash;
  const n = daysUntil(due, today);
  const when = n < 0 ? `${-n}d overdue` : n === 0 ? "today" : `in ${n}d`;
  const tone = ended ? "text-muted" : n < 0 ? "font-semibold text-bad" : n <= 7 ? "font-semibold text-warn" : "";
  return <span className={tone}>{dayLabel(due)} <span className="text-xs">({when})</span></span>;
}

/** The fields of a subscription, for adding one or editing one. */
function PlanFields({ plan, clients, clientId, today }: { plan?: RenewalPlan; clients: { id: string; name: string }[]; clientId?: string; today: string }) {
  return (
    <>
      <label className="flex flex-col gap-0.5">Client
        <select name="client_id" required defaultValue={plan?.client_id ?? clientId ?? ""} className={input}>
          {plan || clientId ? null : <option value="" disabled>Pick a client</option>}
          {plan && !clients.some((c) => c.id === plan.client_id) ? <option value={plan.client_id}>(current)</option> : null}
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-0.5">Name<input name="name" required maxLength={200} defaultValue={plan?.name ?? "Patient Protocol"} className={`${input} w-44`} /></label>
      <label className="flex flex-col gap-0.5">Every (days)<input name="every_days" type="number" min={1} max={366} required defaultValue={plan?.every_days ?? 30} className={`${input} w-20`} /></label>
      <label className="flex flex-col gap-0.5">Amount ($)<input name="amount" type="number" min={0} step="0.01" required defaultValue={plan?.amount ?? ""} className={`${input} w-24`} /></label>
      <label className="flex flex-col gap-0.5">Next due<input name="next_due" type="date" required defaultValue={plan?.next_due ?? addDays(today, 30)} className={input} /></label>
      <label className="flex flex-col gap-0.5">Status
        <select name="status" defaultValue={plan?.status ?? "active"} className={input}>
          {(Object.keys(STATUS) as RenewalStatus[]).map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-0.5">Note<input name="note" maxLength={2000} defaultValue={plan?.note ?? ""} className={`${input} w-48`} /></label>
    </>
  );
}

function PlanRow({ p, today, clients, back }: { p: RenewalPlan; today: string; clients: { id: string; name: string }[]; back: string }) {
  return (
    <tr className="border-b border-line text-sm last:border-0" data-plan={p.id}>
      <td className="py-1.5 pl-8 pr-3 text-muted">{p.name}{p.note ? <div className="text-xs italic">{p.note}</div> : null}</td>
      <td className="whitespace-nowrap px-3 py-1.5"><DueCell due={p.next_due} today={today} ended={p.status === "ended"} /></td>
      <td className="whitespace-nowrap px-3 py-1.5">{p.every_days} days</td>
      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{money(p.amount)}</td>
      <td className="whitespace-nowrap px-3 py-1.5"><span className={`rounded px-1.5 py-0.5 text-xs ${STATUS[p.status].cls}`}>{STATUS[p.status].label}</span></td>
      <td colSpan={4} className="px-3 py-1.5">
        <div className="flex flex-wrap items-start gap-2">
          <form action={renewPlan}>
            <input type="hidden" name="id" value={p.id} /><input type="hidden" name="back" value={back} />
            <button type="submit" className={quiet} title={`Moves next due to ${dayLabel(addDays(p.next_due, p.every_days))}`}>Renewed</button>
          </form>
          <details className="flex-1">
            <summary className="cursor-pointer py-1 text-xs text-muted hover:text-ink">Edit</summary>
            <form action={savePlan} className="mt-2 flex flex-wrap items-end gap-2 text-xs">
              <input type="hidden" name="id" value={p.id} /><input type="hidden" name="back" value={back} />
              <PlanFields plan={p} clients={clients} today={today} />
              <button type="submit" className={button}>Save</button>
            </form>
            <form action={removePlan} className="mt-2">
              <input type="hidden" name="id" value={p.id} /><input type="hidden" name="back" value={back} />
              <button type="submit" className={`${quiet} text-bad`}>Remove this subscription</button>
            </form>
          </details>
        </div>
      </td>
    </tr>
  );
}

function ClientRow({ c, today }: { c: RenewalClient; today: string }) {
  const noFigures = c.no_cortana ? "not connected to Cortana" : c.ads_unverified ? "ad numbers unverified" : null;
  return (
    <tr className="border-b border-t-2 border-line border-t-line bg-canvas" data-client={c.client_id}>
      <td className="px-3 py-2">
        <Link href={`/clients/${c.client_id}`} className="font-medium underline decoration-line underline-offset-2 hover:decoration-ink">{c.client}</Link>
        {c.stage !== "live" ? <span className="ml-2 text-xs text-muted">{c.stage}</span> : null}
      </td>
      <td className="whitespace-nowrap px-3 py-2"><DueCell due={c.next_due} today={today} /></td>
      <td colSpan={3} />
      {noFigures || c.spend === null ? (
        <td colSpan={4} className="px-3 py-2 text-center text-xs text-stale">{noFigures ?? "nothing running"}</td>
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
  const [rows, clients] = await Promise.all([getRenewals(window), getClientChoices()]);
  const today = etToday();
  const back = window === "launch" ? "window=launch" : "";
  const error = typeof params.error === "string" ? ERRORS[params.error] ?? ERRORS.save : null;
  const saved = typeof params.saved === "string" ? SAVED[params.saved] : null;
  const dueSoon = rows.filter((r) => r.next_due && daysUntil(r.next_due, today) <= 7).length;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Renewals</h1>
          <p className="text-xs text-muted">
            {rows.length} clients · {dueSoon} due within 7 days or overdue. Kept by hand here, not synced to Whop.
            Spend and revenue from Cortana, {window === "cycle" ? "this cycle (from the soonest-due subscription's last renewal to today)" : "since launch"}.
            Est. profit = revenue − spend − 30% of revenue.
          </p>
        </div>
        <div className="flex overflow-hidden rounded-md border border-line">
          {(["cycle", "launch"] as const).map((w) => (
            <Link key={w} href={w === "launch" ? "/renewals?window=launch" : "/renewals"} className={`px-3 py-1.5 text-xs ${w === window ? "bg-accent font-medium text-white" : "bg-panel text-muted hover:text-ink"}`}>
              {w === "cycle" ? "This cycle" : "Since launch"}
            </Link>
          ))}
        </div>
      </div>
      {error ? <p className="rounded border border-bad bg-bad-bg px-3 py-2 text-sm text-bad">{error}</p> : null}
      {saved ? <p className="rounded border border-good bg-good-bg px-3 py-2 text-sm text-good">{saved}</p> : null}

      <div className="overflow-x-auto rounded-lg border border-line bg-panel">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-normal">Client / subscription</th>
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
            {rows.length === 0 ? <tr><td colSpan={9} className="px-3 py-6 text-center text-muted">No subscriptions yet. Add one below.</td></tr> : null}
            {rows.map((c) => [
              <ClientRow key={c.client_id} c={c} today={today} />,
              ...c.plans.map((p) => <PlanRow key={p.id} p={p} today={today} clients={clients} back={back} />),
            ])}
          </tbody>
        </table>
      </div>

      <form action={addPlan} className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-panel p-3 text-xs" aria-label="Add a subscription">
        <span className="w-full text-sm font-medium">Add a subscription</span>
        <input type="hidden" name="back" value={back} />
        <PlanFields clients={clients} today={today} />
        <button type="submit" className={button}>Add</button>
      </form>
    </div>
  );
}
