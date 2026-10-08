import Link from "next/link";
import { decideClientRequest, setRouterVerdict } from "@/lib/actions/router";
import { requireStaff } from "@/lib/auth/staff";
import { OWNER_LABEL, getBackfillPending, getHandledInSlack, getRouterAccuracy, getRouterLog, routedHref, type AccuracyRow, type RouterRow } from "@/lib/queries/router";
import { formatDue } from "@/lib/router/replies";

const btn = "cursor-pointer rounded border border-line bg-raised px-2 py-1 text-xs hover:border-muted";
const th = "whitespace-nowrap px-3 py-2 font-normal";
const td = "px-3 py-2 align-top";

const STATUS: Record<string, string> = {
  not_request: "Not a request", routed: "Created", merged: "Added to an open item", triage: "In Triage",
  pending_approval: "Awaiting approval", rejected: "Rejected", handled: "Handled in Slack",
};
const CREATED: Record<string, string> = { tasks: "Task", tech_jobs: "Tech job", exceptions: "Exception" };

const when = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const short = (text: string) => (text.length > 300 ? `${text.slice(0, 300)}…` : text);
const pct = (v: number | null) => (v === null ? "—" : `${v}%`);

function Classification({ r }: { r: RouterRow }) {
  if (r.is_request === null) return <span className="text-muted">—</span>;
  return (
    <div className="text-xs">
      <div className="text-sm">{r.is_request ? `Request${r.owner ? ` · ${OWNER_LABEL[r.owner]}` : " · no owner"}` : "Not a request"}</div>
      {r.title ? <div className="text-muted">“{r.title}”</div> : null}
      <div className="text-muted">
        {r.urgency === "urgent" ? <span className="text-bad">urgent · </span> : null}
        {r.confidence !== null ? `${Math.round(r.confidence * 100)}% confident` : "no confidence"}
        {r.tech_type ? ` · ${r.tech_type}` : ""}
        {r.due_at ? ` · due ${formatDue(r.due_at, r.timezone)}` : ""}
      </div>
    </div>
  );
}

function Outcome({ r }: { r: RouterRow }) {
  const href = routedHref(r);
  return (
    <div className="text-xs">
      <div>{STATUS[r.status] ?? r.status}{r.assigned_owner ? ` · assigned to ${OWNER_LABEL[r.assigned_owner]}` : ""}</div>
      {href && r.routed_table ? <Link href={href} className="underline hover:text-ink">{CREATED[r.routed_table]}</Link> : null}
      {r.triage_reason ? <div className="text-warn">{r.triage_reason}</div> : null}
    </div>
  );
}

function Message({ r }: { r: RouterRow }) {
  return (
    <>
      <p className="whitespace-pre-wrap break-words">{short(r.text)}</p>
      <div className="text-xs text-muted">
        {when(r.received_at)} ET · #{r.channel_kind}{r.mode === "backfill" ? " · backfill" : ""} · <a href={r.permalink} target="_blank" rel="noreferrer" className="underline hover:text-ink">Slack</a>
      </div>
    </>
  );
}

function Totals({ rows, days }: { rows: AccuracyRow[]; days: 7 | 30 }) {
  const of = (owner: AccuracyRow["owner"]) => rows.find((r) => r.window_days === days && r.owner === owner);
  const lines: [string, AccuracyRow | undefined][] = [["All messages", of("all")], ["Tech", of("tech")], ["Ads", of("ads")], ["Ryan", of("ryan")], ["No owner", of("none")]];
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-panel">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted">
          <tr>
            <th className={th}>Last {days} days</th>
            <th className={`${th} text-right`}>Classified</th>
            <th className={`${th} text-right`}>Judged</th>
            <th className={`${th} text-right`}>Right</th>
            <th className={`${th} text-right`}>Wrong</th>
            <th className={`${th} text-right`}>Accuracy</th>
          </tr>
        </thead>
        <tbody>
          {lines.map(([label, r]) => (
            <tr key={label} className="border-t border-line">
              <td className={td}>{label}</td>
              <td className={`${td} text-right tabular-nums`}>{r?.classified ?? 0}</td>
              <td className={`${td} text-right tabular-nums`}>{r?.judged ?? 0}</td>
              <td className={`${td} text-right tabular-nums`}>{r?.right_count ?? 0}</td>
              <td className={`${td} text-right tabular-nums`}>{r?.wrong_count ?? 0}</td>
              <td className={`${td} text-right tabular-nums`}>{pct(r?.accuracy_pct ?? null)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function RouterPage() {
  const me = await requireStaff();
  const isOwner = me.role === "owner";
  const [accuracy, pending, handled, log] = await Promise.all([getRouterAccuracy(), getBackfillPending(), getHandledInSlack(), getRouterLog()]);
  const week = accuracy.find((r) => r.window_days === 7 && r.owner === "all");

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Request router</h1>
          <p className="text-xs text-muted">Every client message the router has classified, and whether it got it right.</p>
        </div>
        <Link href="/data-review?queue=triage" className="text-xs underline hover:text-ink">Back to Triage</Link>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {([["Classified, 7 days", week?.classified ?? 0], ["Judged", week?.judged ?? 0], ["Right", week?.right_count ?? 0], ["Wrong", week?.wrong_count ?? 0], ["Accuracy", pct(week?.accuracy_pct ?? null)]] as const).map(([label, value]) => (
          <div key={label} className="rounded-lg border border-line bg-panel p-3">
            <div className="text-xs text-muted">{label}</div>
            <div className="text-2xl font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Totals rows={accuracy} days={7} />
        <Totals rows={accuracy} days={30} />
      </div>

      <section className="rounded-lg border border-line bg-panel">
        <h2 className="px-4 py-3 text-sm font-semibold">Backfill requests awaiting approval <span className="font-normal text-muted">{pending.length}</span></h2>
        {pending.length === 0 ? (
          <p className="border-t border-line px-4 py-4 text-sm text-muted">Nothing waiting. Requests found by a backfill appear here; none becomes work until it is approved.</p>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {pending.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0 max-w-3xl">
                  <div className="font-medium">{r.client_name}</div>
                  <Message r={r} />
                  <div className="mt-1"><Classification r={r} /></div>
                </div>
                {isOwner ? (
                  <form action={decideClientRequest} className="flex gap-1">
                    <input type="hidden" name="id" value={r.id} />
                    <button name="decision" value="approve" className={btn}>Approve</button>
                    <button name="decision" value="reject" className={btn}>Reject</button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className="rounded-lg border border-line bg-panel">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Handled in Slack <span className="font-normal text-muted">{handled.length === 50 ? "latest 50" : handled.length}</span></summary>
        {handled.length === 0 ? (
          <p className="border-t border-line px-4 py-4 text-sm text-muted">Nothing yet. A Triage item leaves the queue and is listed here once one of us replies in its thread, or posts in that channel after it.</p>
        ) : (
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className={th}>Clinic</th>
                  <th className={th}>Message</th>
                  <th className={th}>Handled by</th>
                  <th className={th}>When</th>
                </tr>
              </thead>
              <tbody>
                {handled.map((h) => (
                  <tr key={h.id} className="border-t border-line">
                    <td className={`${td} whitespace-nowrap`}>{h.client_name}</td>
                    <td className={`${td} max-w-xl`}><a href={h.permalink} target="_blank" rel="noreferrer" className="hover:underline">{h.label}</a></td>
                    <td className={`${td} whitespace-nowrap`}>{h.handled_by ?? "—"}</td>
                    <td className={`${td} whitespace-nowrap text-xs text-muted`}>{when(h.handled_at)} ET</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>

      <section className="overflow-x-auto rounded-lg border border-line bg-panel">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th className={th}>Clinic</th>
              <th className={th}>Message</th>
              <th className={th}>Classification</th>
              <th className={th}>What was created</th>
              <th className={th}>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {log.length === 0 ? (
              <tr className="border-t border-line"><td colSpan={5} className="px-4 py-6 text-muted">No client messages have been classified yet.</td></tr>
            ) : null}
            {log.map((r) => (
              <tr key={r.id} className="border-t border-line">
                <td className={`${td} whitespace-nowrap`}>{r.client_name}</td>
                <td className={`${td} max-w-xl`}><Message r={r} /></td>
                <td className={td}><Classification r={r} /></td>
                <td className={td}><Outcome r={r} /></td>
                <td className={td}>
                  {isOwner ? (
                    <form action={setRouterVerdict} className="flex gap-1">
                      <input type="hidden" name="id" value={r.id} />
                      <button name="verdict" value="right" className={`${btn} ${r.verdict === "right" ? "border-good text-good" : ""}`}>Right</button>
                      <button name="verdict" value="wrong" className={`${btn} ${r.verdict === "wrong" ? "border-bad text-bad" : ""}`}>Wrong</button>
                    </form>
                  ) : (
                    <span className="text-xs text-muted">{r.verdict ?? "not judged"}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
