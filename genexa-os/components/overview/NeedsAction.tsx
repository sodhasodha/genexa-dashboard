import Link from "next/link";
import { assignPayment, categoriseExpense, markLeadReal, resolveException, setAttendance, snoozeException } from "@/lib/actions/overview";
import { formatValue } from "@/lib/format";
import { REVIEW_KINDS, type Bottleneck, type ReviewItem, type ReviewKind } from "@/lib/queries/overview";

const btn = "cursor-pointer rounded border border-line bg-raised px-2 py-1 text-xs hover:border-muted";

function FixButtons({ item, clients, isOwner }: { item: ReviewItem; clients: { id: string; name: string }[]; isOwner: boolean }) {
  if (!isOwner) return null;
  if (item.kind === "unlogged_outcome") {
    return (
      <form action={setAttendance} className="flex flex-wrap gap-1">
        <input type="hidden" name="id" value={item.record_id} />
        {[["showed", "Showed"], ["no_show", "No-show"], ["cancelled", "Cancelled"], ["rescheduled_before_consult", "Rescheduled"]].map(([v, l]) => (
          <button key={v} name="attendance" value={v} className={btn}>{l}</button>
        ))}
      </form>
    );
  }
  if (item.kind === "unmatched_payment") {
    return (
      <form action={assignPayment} className="flex gap-1">
        <input type="hidden" name="id" value={item.record_id} />
        <select name="client_id" required defaultValue="" aria-label="Client" className="rounded border border-line px-1.5 py-1 text-xs">
          <option value="" disabled>Pick client…</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className={btn}>Match</button>
      </form>
    );
  }
  if (item.kind === "uncategorised_expense") {
    return (
      <form action={categoriseExpense} className="flex flex-wrap gap-1">
        <input type="hidden" name="id" value={item.record_id} />
        {["Labor", "Ads", "Software", "Coaching", "Personal", "Other"].map((l) => (
          <button key={l} name="category" value={l.toLowerCase()} className={btn}>{l}</button>
        ))}
      </form>
    );
  }
  if (item.kind === "test_lead") {
    return (
      <form action={markLeadReal}>
        <input type="hidden" name="id" value={item.record_id} />
        <button className={btn}>Real patient</button>
      </form>
    );
  }
  if (item.kind === "eod_issue") return <Link href="/team" className={btn}>Open team</Link>;
  return item.client_id ? <Link href={`/clients/${item.client_id}`} className={btn}>Open client</Link> : null;
}

export function ReviewList({ items, clients, isOwner }: { items: ReviewItem[]; clients: { id: string; name: string }[]; isOwner: boolean }) {
  if (items.length === 0) return <p className="px-4 py-6 text-sm text-muted">Nothing to review here.</p>;
  return (
    <ul className="divide-y divide-line">
      {items.map((item) => (
        <li key={`${item.kind}:${item.record_id}:${item.title}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm">{item.title}</div>
            <div className="truncate text-xs text-muted">{item.detail}</div>
          </div>
          <FixButtons item={item} clients={clients} isOwner={isOwner} />
        </li>
      ))}
    </ul>
  );
}

export function NeedsAction({
  bottlenecks, atRisk, counts, items, clients, panel, queue, isOwner, basePath, periodKey,
}: {
  bottlenecks: Bottleneck[]; atRisk: number; counts: Record<ReviewKind, number>; items: ReviewItem[];
  clients: { id: string; name: string }[]; panel: "bottlenecks" | "review"; queue: ReviewKind; isOwner: boolean; basePath: string; periodKey: string;
}) {
  const reviewTotal = Object.values(counts).reduce((a, b) => a + b, 0);
  const href = (p: string, q?: string) => `${basePath}?period=${periodKey}&panel=${p}${q ? `&queue=${q}` : ""}`;
  const tab = (active: boolean) => `rounded-md px-3 py-1.5 text-xs ${active ? "bg-raised font-medium text-ink" : "text-muted hover:text-ink"}`;
  return (
    <details open className="rounded-lg border border-line bg-panel">
      <summary className="flex items-center gap-2 px-4 py-3 text-sm font-semibold">
        Needs action
        <span className={`rounded-full px-2 py-0.5 text-xs ${bottlenecks.length + reviewTotal > 0 ? "bg-bad-bg text-bad" : "bg-good-bg text-good"}`}>
          {bottlenecks.length + reviewTotal}
        </span>
        {atRisk > 0 ? <span className="ml-auto text-sm font-semibold text-bad">{formatValue(atRisk, "money")} at risk</span> : null}
      </summary>
      <div className="flex flex-wrap gap-1 border-t border-line px-3 py-2">
        <Link href={href("bottlenecks")} className={tab(panel === "bottlenecks")}>Bottlenecks <span className="text-muted">{bottlenecks.length}</span></Link>
        <Link href={href("review", queue)} className={tab(panel === "review")}>Data review <span className="text-muted">{reviewTotal}</span></Link>
      </div>
      {panel === "bottlenecks" ? (
        bottlenecks.length === 0 ? (
          <p className="border-t border-line px-4 py-6 text-sm text-muted">No open exceptions.</p>
        ) : (
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-normal">What</th>
                  <th className="px-2 py-2 font-normal">Owner</th>
                  <th className="px-2 py-2 font-normal">Age</th>
                  <th className="px-2 py-2 text-right font-normal">At risk</th>
                  <th className="px-4 py-2 font-normal">Action</th>
                </tr>
              </thead>
              <tbody>
                {bottlenecks.map((b) => (
                  <tr key={b.id} id={`exception-${b.id}`} className="border-t border-line align-top">
                    <td className="px-4 py-2">
                      <span className={`mr-2 inline-block size-2 rounded-full ${b.severity === "red" ? "bg-bad" : "bg-warn"}`} />
                      {b.reason}
                      {b.action_taken ? <div className="pl-4 text-xs text-muted">Action taken: {b.action_taken}</div> : null}
                      {b.reminded > 0 ? <div className="pl-4 text-xs text-muted">Reminded {b.reminded}×</div> : null}
                    </td>
                    <td className="px-2 py-2 text-muted">{b.owner_name ?? "—"}</td>
                    <td className="px-2 py-2 text-muted">{b.age}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{b.money_at_risk ? formatValue(b.money_at_risk, "money") : "—"}</td>
                    <td className="px-4 py-2">
                      <form className="flex gap-1">
                        <input type="hidden" name="id" value={b.id} />
                        <input name="note" required placeholder="Reason / note" aria-label="Reason or note" className="w-36 rounded border border-line px-1.5 py-1 text-xs" />
                        <button formAction={snoozeException} className={btn}>Snooze 24h</button>
                        <button formAction={resolveException} className={btn}>Resolve</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <div className="border-t border-line">
          <div className="flex flex-wrap gap-1 px-3 py-2">
            {REVIEW_KINDS.map((k) => (
              <Link key={k.kind} href={href("review", k.kind)} className={tab(queue === k.kind)}>
                {k.label} <span className={counts[k.kind] > 0 ? "text-warn" : "text-muted"}>{counts[k.kind]}</span>
              </Link>
            ))}
          </div>
          <div className="border-t border-line">
            <ReviewList items={items.filter((i) => i.kind === queue)} clients={clients} isOwner={isOwner} />
          </div>
        </div>
      )}
    </details>
  );
}
