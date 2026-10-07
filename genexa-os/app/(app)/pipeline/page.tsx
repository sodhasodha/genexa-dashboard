import { addProspect, editProspect, moveProspect, setFollowUp } from "@/lib/actions/pipeline";
import { requireStaff } from "@/lib/auth/staff";
import { getOverdueFollowUps, getPipeline, STAGES, type Prospect } from "@/lib/queries/pipeline";

const ERRORS: Record<string, string> = {
  invalid: "Check the prospect: it needs a name, dates must be real dates, deal size a number, and the Fathom link must start with http.",
  save: "The prospect could not be saved.",
};
const SAVED: Record<string, string> = {
  added: "Prospect added.",
  edited: "Prospect saved.",
  moved: "Stage updated.",
  follow_up: "Follow-up date saved.",
};
const HEAT: Record<string, string> = { hot: "Hot", warm: "Warm", cold: "Cold" };
const HEAT_CLASS: Record<string, string> = { hot: "bg-bad-bg text-bad", warm: "bg-warn-bg text-warn", cold: "bg-stale-bg text-muted" };

const field = "rounded border border-line px-1.5 py-1";
const button = "cursor-pointer rounded bg-accent px-2 py-1 text-xs font-medium text-white";
const quiet = "cursor-pointer rounded border border-line px-2 py-1 text-xs";
const th = "whitespace-nowrap px-3 py-2 font-normal";

function NoData() {
  return <span className="text-stale">no data</span>;
}

function Heat({ heat }: { heat: string | null }) {
  if (!heat) return <NoData />;
  return <span className={`rounded px-1.5 py-0.5 text-xs ${HEAT_CLASS[heat] ?? "bg-stale-bg text-muted"}`}>{HEAT[heat] ?? heat}</span>;
}

function Overdue({ days }: { days: number }) {
  return (
    <span className="font-semibold text-bad">
      overdue {days} {days === 1 ? "day" : "days"}
    </span>
  );
}

function ProspectFields({ p, stage }: { p?: Prospect; stage: string }) {
  const text = (name: string, label: string, value: string | null | undefined, wide = false) => (
    <label className={`flex flex-col gap-1 text-xs text-muted ${wide ? "sm:col-span-2" : ""}`}>
      {label}
      <textarea name={name} rows={2} maxLength={4000} defaultValue={value ?? ""} className={`${field} text-sm`} />
    </label>
  );
  return (
    <>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Name
        <input name="name" required maxLength={200} defaultValue={p?.name ?? ""} className={`${field} text-sm`} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Contact details
        <input name="contact" maxLength={500} defaultValue={p?.contact ?? ""} className={`${field} text-sm`} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        State
        <input name="state" maxLength={60} defaultValue={p?.state ?? ""} className={`${field} text-sm`} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Heat
        <select name="heat" defaultValue={p?.heat ?? ""} className={`${field} text-sm`}>
          <option value="">Not set</option>
          {Object.entries(HEAT).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Stage
        <select name="stage" defaultValue={stage} className={`${field} text-sm`}>
          {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Call date
        <input type="date" name="call_date" defaultValue={p?.call_date ?? ""} className={`${field} text-sm`} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Follow-up date
        <input type="date" name="follow_up_date" defaultValue={p?.follow_up_date ?? ""} className={`${field} text-sm`} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Deal size ($)
        <input name="deal_size" inputMode="decimal" defaultValue={p?.deal_size ?? ""} className={`${field} text-sm`} />
      </label>
      {text("what_they_want", "What they want", p?.what_they_want)}
      {text("objection", "Objection", p?.objection)}
      {text("promised", "What Ryan promised", p?.promised)}
      <label className="flex flex-col gap-1 text-xs text-muted">
        Fathom link
        <input type="url" name="fathom_url" maxLength={1000} defaultValue={p?.fathom_url ?? ""} className={`${field} text-sm`} />
      </label>
    </>
  );
}

export default async function PipelinePage({ searchParams }: PageProps<"/pipeline">) {
  const me = await requireStaff();
  const params = await searchParams;
  const isOwner = me.role === "owner";
  const [followUps, stages] = await Promise.all([getOverdueFollowUps(), getPipeline(isOwner)]);
  const error = typeof params.error === "string" ? ERRORS[params.error] : undefined;
  const saved = typeof params.saved === "string" ? SAVED[params.saved] : undefined;

  return (
    <div className="flex flex-col gap-6 p-4">
      <div>
        <h1 className="text-lg font-semibold">Pipeline</h1>
        {error ? <p className="mt-2 rounded bg-bad-bg px-3 py-2 text-bad">{error}</p> : null}
        {saved ? <p className="mt-2 rounded bg-good-bg px-3 py-2 text-good">{saved}</p> : null}
      </div>

      <section>
        <h2 className="mb-2 font-semibold">
          Overdue follow-ups <span className="ml-1 font-normal tabular-nums text-muted">{followUps.length}</span>
        </h2>
        {followUps.length === 0 ? (
          <p className="rounded border border-line bg-panel px-4 py-4 text-sm text-muted">No follow-ups are overdue.</p>
        ) : (
          <div className="overflow-x-auto rounded border border-bad bg-panel">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-xs text-muted">
                <tr>
                  <th className={th}>Prospect</th>
                  <th className={th}>Heat</th>
                  <th className={th}>Stage</th>
                  <th className={th}>Follow-up was due</th>
                  <th className={th}>What Ryan promised</th>
                  <th className={th}>Deal size</th>
                </tr>
              </thead>
              <tbody>
                {followUps.map((f) => (
                  <tr key={f.id} className="border-b border-line align-top last:border-0">
                    <td className="px-3 py-2 font-medium">
                      {f.name}
                      {f.state ? <span className="ml-2 text-xs font-normal text-muted">{f.state}</span> : null}
                    </td>
                    <td className="px-3 py-2"><Heat heat={f.heat} /></td>
                    <td className="whitespace-nowrap px-3 py-2">{f.stage_label}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                      {f.follow_up_label} · <Overdue days={f.days_overdue} />
                    </td>
                    <td className="max-w-md whitespace-pre-wrap px-3 py-2">{f.promised ?? <NoData />}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">{f.deal_label ?? <NoData />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {isOwner ? (
        <details className="rounded border border-line bg-panel">
          <summary className="px-3 py-2 font-medium">Add a prospect</summary>
          <form action={addProspect} className="grid gap-3 border-t border-line p-3 sm:grid-cols-2 lg:grid-cols-4">
            <ProspectFields stage="chase" />
            <div className="flex items-end">
              <button type="submit" className={button}>Add prospect</button>
            </div>
          </form>
        </details>
      ) : null}

      {stages.map((s) => (
        <section key={s.key}>
          <h2 className="mb-2 font-semibold">
            {s.label} <span className="ml-1 font-normal tabular-nums text-muted">{s.count}</span>
            {s.deal_total_label ? (
              <span className="ml-3 text-xs font-normal text-muted">
                {s.deal_total_label} across the {s.deals_recorded} with a deal size
              </span>
            ) : null}
          </h2>
          {s.prospects.length === 0 ? (
            <p className="rounded border border-line bg-panel px-4 py-4 text-sm text-muted">No prospects in this stage.</p>
          ) : (
            <div className="overflow-x-auto rounded border border-line bg-panel">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-line text-xs text-muted">
                  <tr>
                    <th className={th}>Name</th>
                    <th className={th}>Heat</th>
                    <th className={th}>State</th>
                    <th className={th}>Call date</th>
                    <th className={th}>What they want</th>
                    <th className={th}>Objection</th>
                    <th className={th}>Promised</th>
                    <th className={th}>Follow-up</th>
                    <th className={th}>Deal size</th>
                    <th className={th}>Fathom</th>
                    {isOwner ? <th className={th}>Contact</th> : null}
                    {isOwner ? <th className={th}>Change</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {s.prospects.map((p) => (
                    <tr key={p.id} className="border-b border-line align-top last:border-0">
                      <td className="px-3 py-2 font-medium">{p.name}</td>
                      <td className="px-3 py-2"><Heat heat={p.heat} /></td>
                      <td className="whitespace-nowrap px-3 py-2">{p.state ?? <NoData />}</td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums">{p.call_label ?? <NoData />}</td>
                      <td className="max-w-xs whitespace-pre-wrap px-3 py-2">{p.what_they_want ?? <NoData />}</td>
                      <td className="max-w-xs whitespace-pre-wrap px-3 py-2">{p.objection ?? <NoData />}</td>
                      <td className="max-w-xs whitespace-pre-wrap px-3 py-2">{p.promised ?? <NoData />}</td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                        {p.follow_up_label ?? <NoData />}
                        {p.days_overdue !== null ? <span className="block text-xs"><Overdue days={p.days_overdue} /></span> : null}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums">{p.deal_label ?? <NoData />}</td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {p.fathom_link ? (
                          <a href={p.fathom_link} target="_blank" rel="noopener noreferrer" className="text-accent underline">Recording</a>
                        ) : (
                          <NoData />
                        )}
                      </td>
                      {isOwner ? <td className="max-w-xs whitespace-pre-wrap px-3 py-2">{p.contact ?? <NoData />}</td> : null}
                      {isOwner ? (
                        <td className="px-3 py-2">
                          <div className="flex flex-col gap-1.5">
                            <form action={moveProspect} className="flex items-center gap-1">
                              <input type="hidden" name="id" value={p.id} />
                              <select name="stage" defaultValue={p.stage} aria-label={`Stage of ${p.name}`} className={`${field} text-xs`}>
                                {STAGES.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                              </select>
                              <button type="submit" className={quiet}>Move</button>
                            </form>
                            <form action={setFollowUp} className="flex items-center gap-1">
                              <input type="hidden" name="id" value={p.id} />
                              <input type="date" name="follow_up_date" defaultValue={p.follow_up_date ?? ""} aria-label={`Follow-up date for ${p.name}`} className={`${field} text-xs`} />
                              <button type="submit" className={quiet}>Set</button>
                            </form>
                            <details>
                              <summary className="text-xs text-muted">Edit</summary>
                              <form action={editProspect} className="mt-2 grid w-80 gap-2 sm:grid-cols-2">
                                <input type="hidden" name="id" value={p.id} />
                                <ProspectFields p={p} stage={p.stage} />
                                <div className="flex items-end">
                                  <button type="submit" className={button}>Save</button>
                                </div>
                              </form>
                            </details>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
