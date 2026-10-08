import Link from "next/link";
import { notFound } from "next/navigation";
import { CloseFollowUp } from "@/components/pipeline/CloseFollowUp";
import { undoFollowUpDecision } from "@/lib/actions/pipeline";
import { requireStaff } from "@/lib/auth/staff";
import { DECISION_ERRORS, DECISION_SAVED } from "@/lib/pipeline/reasons";
import { earliestLaterDay, getProspect, STAGES } from "@/lib/queries/pipeline";

const ERRORS: Record<string, string> = { ...DECISION_ERRORS, invalid: "Not saved: that prospect could not be found.", save: "Not saved: the database refused the change." };
const HEAT: Record<string, string> = { hot: "Hot", warm: "Warm", cold: "Cold" };
const STAGE_LABEL: Record<string, string> = Object.fromEntries(STAGES.map((s) => [s.key, s.label]));
const NO_DATA = <span className="text-stale">no data</span>;
const button = "cursor-pointer rounded bg-accent px-3 py-1.5 text-xs font-medium text-white";
const th = "whitespace-nowrap px-3 py-2 font-normal";

/** One prospect: its details, the follow-up decisions made on it, and the undo. Staff read; only the owner acts. */
export default async function ProspectPage({ params, searchParams }: PageProps<"/pipeline/[id]">) {
  const me = await requireStaff();
  const { id } = await params;
  const query = await searchParams;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const isOwner = me.role === "owner";
  const page = await getProspect(id, isOwner);
  if (!page) notFound();
  const { prospect: p, decisions, undo_label } = page;
  const error = typeof query.error === "string" ? ERRORS[query.error] : undefined;
  const saved = typeof query.saved === "string" ? DECISION_SAVED[query.saved] : undefined;

  const facts: [string, React.ReactNode][] = [
    ["Stage", STAGE_LABEL[p.stage] ?? p.stage],
    ["Heat", p.heat ? (HEAT[p.heat] ?? p.heat) : null],
    ["State", p.state],
    ["Call date", p.call_label],
    ["Follow-up", p.follow_up_label ? (
      <>
        {p.follow_up_label}
        {p.days_overdue !== null ? <span className="ml-2 font-semibold text-bad">overdue {p.days_overdue} {p.days_overdue === 1 ? "day" : "days"}</span> : null}
      </>
    ) : null],
    ["Deal size", p.deal_label],
    ["What they want", p.what_they_want],
    ["Objection", p.objection],
    ["What Ryan promised", p.promised],
    ["Fathom", p.fathom_link ? <a href={p.fathom_link} target="_blank" rel="noopener noreferrer" className="text-accent underline">Recording</a> : null],
  ];
  // Contact details are owner only: the row is not even listed for anyone else.
  if (isOwner) facts.push(["Contact", p.contact]);

  return (
    <div className="flex flex-col gap-5 p-4">
      <Link href="/pipeline" className="text-xs text-muted underline">← Pipeline</Link>
      <h1 className="text-lg font-semibold">{p.name}</h1>
      {error ? <p className="rounded bg-bad-bg px-3 py-2 text-sm text-bad">{error}</p> : null}
      {saved ? <p className="rounded bg-good-bg px-3 py-2 text-sm text-good">{saved}</p> : null}

      <dl className="grid gap-x-6 gap-y-3 rounded border border-line bg-panel p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="whitespace-pre-wrap">{value ?? NO_DATA}</dd>
          </div>
        ))}
      </dl>

      {isOwner && (undo_label || p.can_close) ? (
        <section className="flex flex-wrap items-start gap-6 rounded border border-line bg-panel p-4">
          {undo_label ? (
            <form action={undoFollowUpDecision}>
              <input type="hidden" name="id" value={p.id} />
              <input type="hidden" name="from" value="prospect" />
              <button type="submit" className={button}>{undo_label}</button>
            </form>
          ) : null}
          {p.can_close ? <CloseFollowUp id={p.id} name={p.name} earliest={earliestLaterDay()} from="prospect" /> : null}
        </section>
      ) : null}

      <section>
        <h2 className="mb-2 font-semibold">
          Follow-up decisions <span className="ml-1 font-normal tabular-nums text-muted">{decisions.length}</span>
        </h2>
        {decisions.length === 0 ? (
          <p className="rounded border border-line bg-panel px-4 py-4 text-sm text-muted">No follow-up has been closed or moved for this prospect.</p>
        ) : (
          <div className="overflow-x-auto rounded border border-line bg-panel">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-xs text-muted">
                <tr>
                  <th className={th}>Decision</th>
                  <th className={th}>Before it</th>
                  <th className={th}>By</th>
                  <th className={th}>Undone</th>
                </tr>
              </thead>
              <tbody>
                {decisions.map((d) => (
                  <tr key={d.id} className="border-b border-line align-top last:border-0">
                    <td className="max-w-md px-3 py-2">
                      {d.what}
                      {d.note ? <span className="block whitespace-pre-wrap text-xs text-muted">{d.note}</span> : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{d.before}</td>
                    <td className="whitespace-nowrap px-3 py-2">{d.who}</td>
                    <td className="whitespace-nowrap px-3 py-2">{d.undone ?? <span className="text-muted">no</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
