import Link from "next/link";
import { assignPayment, categoriseExpense, classifyPayment, dismissReviewItem, markLeadReal, resolveException, resolveFeeMismatch, setAttendance, snoozeException } from "@/lib/actions/overview";
import { resolveCall } from "@/lib/actions/calls";
import { decideClientRequest } from "@/lib/actions/router";
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
  if (item.kind === "unmatched_call" && item.call) {
    const call = item.call;
    return (
      <form action={resolveCall} className="flex flex-wrap items-center gap-1">
        <input type="hidden" name="id" value={item.record_id} />
        <select name="target" defaultValue={call.suggested ?? ""} aria-label="Who the call was with" className="max-w-56 rounded border border-line px-1.5 py-1 text-xs">
          <option value="">Pick who this was…</option>
          <optgroup label="Prospects">
            {call.prospects.map((p) => <option key={p.id} value={`prospect:${p.id}`}>{p.name}{call.suggested === `prospect:${p.id}` ? " (suggested)" : ""}</option>)}
          </optgroup>
          <optgroup label="Clients">
            {clients.map((c) => <option key={c.id} value={`client:${c.id}`}>{c.name}{call.suggested === `client:${c.id}` ? " (suggested)" : ""}</option>)}
          </optgroup>
        </select>
        <button name="decision" value="assign" className={btn}>This is them</button>
        <button name="decision" value="new_prospect" className={btn} title={call.person ? `Creates the prospect "${call.person}"` : undefined}>New prospect</button>
        <button name="decision" value="ignore" className={btn}>Ignore</button>
      </form>
    );
  }
  if (item.kind === "unclassified_payment") {
    return (
      <form action={classifyPayment} className="flex flex-wrap gap-1">
        <input type="hidden" name="id" value={item.record_id} />
        {[["rev_share", "Rev share"], ["retainer", "Retainer"], ["setup", "Set-up fee"], ["other", "Other income"]].map(([v, l]) => (
          <button key={v} name="label" value={v} className={btn}>{l}</button>
        ))}
      </form>
    );
  }
  if (item.record_table === "client_fees") {
    return (
      <form action={resolveFeeMismatch} className="flex gap-1">
        <input type="hidden" name="id" value={item.record_id} />
        <button name="choice" value="whop" className={btn}>Use Whop fee</button>
        <button name="choice" value="keep" className={btn}>Keep fee on record</button>
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
        <button name="category" value="revenue" className={btn}>Revenue</button>
        <button name="category" value="not_business" className={btn}>Not Genexa</button>
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

const OWNER_NAME: Record<string, string> = { tech: "Tech", ads: "Ads", ryan: "Ryan" };

/** Triage: client requests the router could not place. The owner assigns each one, or says it is not a request. */
function TriageList({ items, isOwner }: { items: ReviewItem[]; isOwner: boolean }) {
  return (
    <div>
      <p className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2 text-xs text-muted">
        Client messages the router was not sure about. Assigning one creates the work for that person.
        <Link href="/router" className="underline hover:text-ink">How accurate is the router?</Link>
      </p>
      {items.length === 0 ? <p className="px-4 py-6 text-sm text-muted">Nothing to review here.</p> : null}
      <ul className="divide-y divide-line">
        {items.map((item) => {
          const t = item.triage;
          const guess = !t || t.is_request === null
            ? "Not classified"
            : `${t.is_request ? `Request${t.owner ? ` for ${OWNER_NAME[t.owner] ?? t.owner}` : ", no owner"}` : "Not a request"}${t.urgency === "urgent" ? " · urgent" : ""}${t.confidence !== null ? ` · ${Math.round(t.confidence * 100)}% confident` : ""}`;
          return (
            <li key={item.item_key} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0 max-w-3xl">
                <div className="text-sm font-medium">
                  {item.title}
                  {t ? <span className="ml-2 text-xs font-normal text-muted">#{t.channel_kind}{t.mode === "backfill" ? " · from backfill" : ""}</span> : null}
                </div>
                <p className="whitespace-pre-wrap break-words text-sm">{item.detail}</p>
                <div className="mt-1 text-xs text-muted">
                  Router&apos;s guess: {guess}{t?.guess_title ? ` · “${t.guess_title}”` : ""}
                  {t?.reason ? <span className="text-warn"> · {t.reason}</span> : null}
                  {t ? <> · <a href={t.permalink} target="_blank" rel="noreferrer" className="underline hover:text-ink">Open in Slack</a></> : null}
                </div>
              </div>
              {isOwner ? (
                <form action={decideClientRequest} className="flex flex-wrap items-center gap-1">
                  <input type="hidden" name="id" value={item.record_id} />
                  <span className="text-xs text-muted">Assign →</span>
                  {Object.entries(OWNER_NAME).map(([value, label]) => (
                    <button key={value} name="owner" value={value} className={btn}>{label}</button>
                  ))}
                  <button name="decision" value="not_request" className={btn}>Not a request</button>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ReviewList({ items, clients, isOwner, queue }: { items: ReviewItem[]; clients: { id: string; name: string }[]; isOwner: boolean; queue?: ReviewKind }) {
  if (queue === "triage" || (items.length > 0 && items.every((i) => i.kind === "triage"))) return <TriageList items={items} isOwner={isOwner} />;
  if (items.length === 0) return <p className="px-4 py-6 text-sm text-muted">Nothing to review here.</p>;
  return (
    <ul className="divide-y divide-line">
      {items.map((item) => (
        <li key={item.item_key} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm">{item.title}</div>
            <div className="truncate text-xs text-muted">{item.detail}</div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <FixButtons item={item} clients={clients} isOwner={isOwner} />
            {isOwner && item.kind !== "unmatched_call" ? (
              <form action={dismissReviewItem} className="flex gap-1">
                <input type="hidden" name="item_key" value={item.item_key} />
                <input type="hidden" name="kind" value={item.kind} />
                <input type="hidden" name="title" value={item.title} />
                <input name="reason" required placeholder="Reason" aria-label="Reason for dismissing" className="w-28 rounded border border-line px-1.5 py-1 text-xs" />
                <button className={btn}>Dismiss</button>
              </form>
            ) : null}
          </div>
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
            <ReviewList items={items.filter((i) => i.kind === queue)} clients={clients} isOwner={isOwner} queue={queue} />
          </div>
        </div>
      )}
    </details>
  );
}
