import { pauseJob, requestTechWork, resumeJob, setBlockedOn, setJobStatus } from "@/lib/actions/tech";
import { requireStaff } from "@/lib/auth/staff";
import {
  JOB_STATUSES, JOB_TYPES, PAUSE_REASONS, PAUSE_REASON_LABEL,
  getClientOptions, getDoneThisWeek, getOpenJobs, getTechScorecard, type ScoreCell, type TechJob,
} from "@/lib/queries/tech";

const ERRORS: Record<string, string> = {
  request_invalid: "Pick a type and enter a title.",
  request_save: "The request could not be saved.",
  no_tech: "There is no tech person on the team to send this to. Add one on the Team page.",
  invalid: "That did not look right. Try again.",
  save: "The change could not be saved.",
  not_yours: "Only the job's owner or the app owner can change a job.",
  pause_invalid: "A pause needs a reason and an evidence note.",
  already_paused: "This job is already paused.",
  not_paused: "There is no open pause on this job, or it is not your job.",
};
const SAVED: Record<string, string> = {
  requested: "Request sent to tech.",
  status: "Status saved.",
  blocked: "Blocked-on saved.",
  paused: "Job paused. The SLA clock is stopped.",
  resumed: "Job resumed. The SLA clock is running.",
};
const STATUS_CLASS: Record<string, string> = {
  todo: "bg-stale-bg text-muted",
  working: "bg-good-bg text-good",
  stuck: "bg-bad-bg text-bad",
  done: "bg-good-bg text-good",
};
const COLOUR_CLASS: Record<string, string> = {
  green: "border-good bg-good-bg text-good",
  amber: "border-warn bg-warn-bg text-warn",
  red: "border-bad bg-bad-bg text-bad",
};
const input = "rounded border border-line px-1.5 py-1";
const smallButton = "cursor-pointer rounded border border-line px-2 py-1 text-xs hover:border-muted";
const NoData = () => <span className="text-stale">no data</span>;
const th = "whitespace-nowrap px-3 py-2 font-normal";
const td = "px-3 py-2 align-top";

function ScoreTile({ cell }: { cell: ScoreCell }) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 rounded-lg border p-3 ${cell.colour ? COLOUR_CLASS[cell.colour] : "border-line bg-panel"}`}>
      <span className="text-xs text-muted">{cell.label}</span>
      <span className="text-2xl font-semibold tabular-nums">{cell.value ?? <NoData />}</span>
      <span className="text-xs text-muted">{cell.detail ?? "nothing to measure"}</span>
      <span className="text-xs text-muted">{cell.target ?? "shown, not scored"}</span>
    </div>
  );
}

function JobControls({ job }: { job: TechJob }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
      <form action={setJobStatus} className="flex items-center gap-1">
        <input type="hidden" name="job_id" value={job.id} />
        <span className="text-muted">Status</span>
        {JOB_STATUSES.map((s) => (
          <button
            key={s} type="submit" name="status" value={s} disabled={s === job.status}
            className={s === job.status ? "rounded bg-accent px-2 py-1 text-xs font-medium text-white" : smallButton}
          >
            {s}
          </button>
        ))}
      </form>
      <form action={setBlockedOn} className="flex items-center gap-1">
        <input type="hidden" name="job_id" value={job.id} />
        <label className="flex items-center gap-1">
          <span className="text-muted">Blocked on</span>
          <input name="blocked_on" defaultValue={job.blocked_on ?? ""} maxLength={500} placeholder="nothing" className={`${input} w-56`} />
        </label>
        <button type="submit" className={smallButton}>Save</button>
      </form>
      {job.is_paused ? (
        <form action={resumeJob}>
          <input type="hidden" name="job_id" value={job.id} />
          <button type="submit" className="cursor-pointer rounded bg-accent px-2 py-1 text-xs font-medium text-white">Resume</button>
        </form>
      ) : (
        <form action={pauseJob} className="flex flex-wrap items-center gap-1">
          <input type="hidden" name="job_id" value={job.id} />
          <span className="text-muted">Pause</span>
          <select name="reason" required defaultValue="" aria-label={`Pause reason for ${job.title}`} className={input}>
            <option value="" disabled>reason</option>
            {PAUSE_REASONS.map((r) => <option key={r} value={r}>{PAUSE_REASON_LABEL[r]}</option>)}
          </select>
          <input
            name="evidence_note" required maxLength={1000} placeholder="Evidence: where and when you asked"
            aria-label={`Pause evidence for ${job.title}`} className={`${input} w-64`}
          />
          <button type="submit" className={smallButton}>Pause</button>
        </form>
      )}
    </div>
  );
}

export default async function TechPage({ searchParams }: PageProps<"/tech">) {
  const me = await requireStaff();
  const params = await searchParams;
  const [open, done, clients, scorecard] = await Promise.all([getOpenJobs(me), getDoneThisWeek(me), getClientOptions(), getTechScorecard()]);
  const error = typeof params.error === "string" ? ERRORS[params.error] : undefined;
  const saved = typeof params.saved === "string" ? SAVED[params.saved] : undefined;
  const overdue = open.filter((j) => j.is_overdue).length;

  return (
    <div className="flex flex-col gap-6 p-4">
      <div>
        <h1 className="text-lg font-semibold">Tech</h1>
        <p className="mt-1 text-xs text-muted">
          Genexa time is time on the job minus time paused waiting on someone outside Genexa. Fixes count business minutes
          (09:00 to 17:00 ET, Mon to Fri). All times are ET.
        </p>
        {error ? <p className="mt-2 rounded bg-bad-bg px-3 py-2 text-bad">{error}</p> : null}
        {saved ? <p className="mt-2 rounded bg-good-bg px-3 py-2 text-good">{saved}</p> : null}
      </div>

      <section>
        <h2 className="mb-2 font-semibold">Scorecard{scorecard.tech_name ? `: ${scorecard.tech_name}` : ""}</h2>
        {scorecard.weeks.length === 0 ? (
          <p className="rounded border border-line bg-panel px-4 py-6 text-sm text-muted">
            No data. Nobody on the team has the tech role, so there is no scorecard.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {scorecard.weeks.map((w) => (
              <div key={w.week_start}>
                <h3 className="mb-1 text-xs text-muted">{w.label}</h3>
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  {w.cells.map((c) => <ScoreTile key={c.metric} cell={c} />)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-1 font-semibold">Open jobs</h2>
        <p className="mb-2 text-xs text-muted">
          {open.length} open.{" "}
          {overdue > 0 ? <span className="font-semibold text-bad">{overdue} overdue.</span> : "None overdue."}
        </p>
        {open.length === 0 ? (
          <p className="rounded border border-line bg-panel px-4 py-6 text-sm text-muted">No open jobs.</p>
        ) : (
          <div className="overflow-x-auto rounded border border-line bg-panel">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-xs text-muted">
                <tr>
                  {["Type", "Clinic", "Title", "Requested (ET)", "Due (ET)", "Genexa time", "Paused time", "Status", "Blocked on"].map((c) => (
                    <th key={c} className={th}>{c}</th>
                  ))}
                </tr>
              </thead>
              {open.map((j) => (
                <tbody key={j.id} className="border-b border-line last:border-0">
                  <tr>
                    <td className={td}>{j.type}</td>
                    <td className={td}>{j.client_name ?? <span className="text-muted">—</span>}</td>
                    <td className={`${td} max-w-md`}>
                      <span className="font-medium">{j.title}</span>
                      {j.notes ? <span className="block whitespace-pre-wrap text-xs text-muted">{j.notes}</span> : null}
                      <span className="block text-xs text-muted">
                        {j.requested_by_name ? `Requested by ${j.requested_by_name}` : "Requester not recorded"}
                        {j.owner_name ? ` · owner ${j.owner_name}` : " · no owner"}
                      </span>
                    </td>
                    <td className={`${td} whitespace-nowrap tabular-nums`}>{j.requested ?? <NoData />}</td>
                    <td className={`${td} whitespace-nowrap tabular-nums`}>
                      {j.due ?? <span className="text-muted">no SLA</span>}
                      {j.is_overdue ? <span className="ml-2 rounded bg-bad-bg px-1.5 py-0.5 text-xs font-semibold text-bad">overdue</span> : null}
                    </td>
                    <td className={`${td} whitespace-nowrap tabular-nums`}>
                      {j.genexa_time ?? <NoData />}
                      {j.sla_time ? <span className="text-xs text-muted"> of {j.sla_time}</span> : null}
                    </td>
                    <td className={`${td} whitespace-nowrap tabular-nums`}>{j.paused_time ?? <NoData />}</td>
                    <td className={`${td} whitespace-nowrap`}>
                      <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_CLASS[j.status] ?? ""}`}>{j.status}</span>
                      {j.is_paused ? (
                        <span title={j.pause_evidence ?? undefined} className="ml-1 rounded bg-warn-bg px-1.5 py-0.5 text-xs text-warn">
                          paused · {j.pause_reason ?? "no reason recorded"}
                        </span>
                      ) : null}
                    </td>
                    <td className={`${td} max-w-xs`}>{j.blocked_on ?? <span className="text-muted">—</span>}</td>
                  </tr>
                  {j.is_paused && j.pause_evidence ? (
                    <tr>
                      <td colSpan={9} className="px-3 pb-2 text-xs text-muted">Pause evidence: {j.pause_evidence}</td>
                    </tr>
                  ) : null}
                  {j.can_edit ? (
                    <tr>
                      <td colSpan={9} className="bg-raised px-3 py-2"><JobControls job={j} /></td>
                    </tr>
                  ) : null}
                </tbody>
              ))}
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Done this week</h2>
        {done.length === 0 ? (
          <p className="rounded border border-line bg-panel px-4 py-6 text-sm text-muted">Nothing completed yet this week.</p>
        ) : (
          <div className="overflow-x-auto rounded border border-line bg-panel">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-xs text-muted">
                <tr>
                  {["Type", "Clinic", "Title", "Requested (ET)", "Done (ET)", "Genexa time taken", "Paused time", "SLA", ""].map((c, i) => (
                    <th key={i} className={th}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {done.map((j) => (
                  <tr key={j.id} className="border-b border-line last:border-0">
                    <td className={td}>{j.type}</td>
                    <td className={td}>{j.client_name ?? <span className="text-muted">—</span>}</td>
                    <td className={`${td} max-w-md font-medium`}>{j.title}</td>
                    <td className={`${td} whitespace-nowrap tabular-nums`}>{j.requested ?? <NoData />}</td>
                    <td className={`${td} whitespace-nowrap tabular-nums`}>{j.done ?? <NoData />}</td>
                    <td className={`${td} whitespace-nowrap tabular-nums`}>
                      {j.genexa_time ?? <NoData />}
                      {j.sla_time ? <span className="text-xs text-muted"> of {j.sla_time}</span> : null}
                    </td>
                    <td className={`${td} whitespace-nowrap tabular-nums`}>{j.paused_time ?? <NoData />}</td>
                    <td className={td}>
                      {j.met_sla === null ? (
                        <span className="text-muted">no SLA</span>
                      ) : j.met_sla ? (
                        <span className="rounded bg-good-bg px-1.5 py-0.5 text-xs text-good">met</span>
                      ) : (
                        <span className="rounded bg-bad-bg px-1.5 py-0.5 text-xs text-bad">missed</span>
                      )}
                    </td>
                    <td className={td}>
                      {j.can_edit ? (
                        <form action={setJobStatus}>
                          <input type="hidden" name="job_id" value={j.id} />
                          <button type="submit" name="status" value="working" className={smallButton}>Reopen</button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-1 font-semibold">Request tech work</h2>
        <p className="mb-2 text-xs text-muted">
          This form is the only way tech work is requested. A launch is due 48 hours after the request; a fix is due 30
          business minutes after it.
        </p>
        <form action={requestTechWork} className="flex max-w-2xl flex-col gap-3 rounded border border-line bg-panel p-4">
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-xs text-muted">
              Type
              <select name="type" required defaultValue="" className={`${input} text-sm`}>
                <option value="" disabled>choose</option>
                {JOB_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Clinic (optional)
              <select name="client_id" defaultValue="" className={`${input} text-sm`}>
                <option value="">no clinic</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Title
            <input name="title" required maxLength={200} className={`${input} text-sm`} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Notes
            <textarea name="notes" rows={3} maxLength={4000} className={`${input} text-sm`} />
          </label>
          <div>
            <button type="submit" className="cursor-pointer rounded bg-accent px-3 py-1.5 text-sm font-medium text-white">Send to tech</button>
          </div>
        </form>
      </section>
    </div>
  );
}
