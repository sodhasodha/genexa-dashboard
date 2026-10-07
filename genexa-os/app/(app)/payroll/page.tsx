import Link from "next/link";
import {
  addFreelanceJob, approveAllPayLines, approvePayLine, markPayRunPaid, rebuildPayRun, setOvertimeApproved, setPayAdjustment, updatePay,
} from "@/lib/actions/payroll";
import { requireOwner } from "@/lib/auth/staff";
import { dayMonth, usd } from "@/lib/payroll/format";
import { defaultPayWeek, isDate, weekStartOf } from "@/lib/payroll/week";
import { wiseLines } from "@/lib/payroll/wise";
import { formatDay } from "@/lib/queries/dates";
import {
  getFreelanceJobs, getPayDays, getPayLines, getPayPeople, getPayRun, getSetupGaps, type PayLine, type PayStatus,
} from "@/lib/queries/payroll";
import { addDays, etToday } from "@/lib/time";

// Display only. Every figure on this page is computed in SQL (0026_payroll.sql).

const PAY_TYPE: Record<string, string> = { hourly: "Hourly", fixed_monthly: "Fixed monthly", freelance: "Freelance" };
const SAVED: Record<string, string> = {
  built: "Draft rebuilt from attendance.",
  approved: "Line approved.",
  approved_all: "Approved every line that has a pay type and a rate.",
  paid: "Marked paid.",
  adjustment: "Adjustment saved.",
  overtime: "Overtime updated and the draft recomputed.",
  job: "Freelance job added.",
  pay: "Pay settings saved.",
};
const ERRORS: Record<string, string> = {
  week: "Pick a week.",
  invalid: "That did not go through. Reload and try again.",
  build: "The draft could not be built.",
  cannot_approve: "That line cannot be approved: it has no pay type or no rate.",
  not_draft: "That line is already approved or paid, so it cannot be changed.",
  approve: "The run could not be approved.",
  not_approved: "Approve the run before marking it paid.",
  paid: "The run could not be marked paid.",
  adjustment_invalid: "Enter the adjustment as an amount, such as 25 or -25.",
  adjustment_reason: "An adjustment needs a reason.",
  adjustment_save: "The adjustment could not be saved.",
  overtime: "Overtime could not be updated.",
  job_invalid: "A freelance job needs a person, a date, a description and an amount above 0.",
  job_save: "The freelance job could not be saved.",
  pay_invalid: "Check the pay type and the amounts.",
  pay_save: "Pay settings could not be saved.",
};
const STATUS_CLASS: Record<PayStatus, string> = { draft: "bg-stale-bg text-muted", approved: "bg-warn-bg text-warn", paid: "bg-good-bg text-good" };

const input = "rounded border border-line px-1.5 py-1";
const button = "cursor-pointer rounded bg-accent px-2 py-1 text-xs font-medium text-white";
const quiet = "cursor-pointer rounded border border-line px-2 py-1 text-xs";

const hours = (h: number) => h.toFixed(2);
const etTime = (ts: string | null) =>
  ts ? new Date(ts).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : null;

function StatusPill({ status }: { status: PayStatus }) {
  return <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_CLASS[status]}`}>{status}</span>;
}

function Money({ value, missing }: { value: number | null; missing: string }) {
  return value === null ? <span className="text-bad">{missing}</span> : <>{usd(value)}</>;
}

function rateText(l: PayLine) {
  if (l.pay_type === "freelance") return <span className="text-muted">per job</span>;
  if (l.rate === null) return <span className="text-bad">not entered</span>;
  return <>{usd(l.rate)}{l.pay_type === "hourly" ? " / h" : " / month"}</>;
}

export default async function PayrollPage({ searchParams }: PageProps<"/payroll">) {
  await requireOwner();
  const params = await searchParams;
  const week = isDate(params.week) ? weekStartOf(params.week) : defaultPayWeek(etToday());
  const weekEnd = addDays(week, 6);

  const [run, gaps, people, days, jobs] = await Promise.all([getPayRun(week), getSetupGaps(), getPayPeople(), getPayDays(week), getFreelanceJobs(week)]);
  const lines = run ? await getPayLines(run.id) : [];
  const nameOf = new Map(people.map((p) => [p.staff_id, p.name]));
  for (const l of lines) nameOf.set(l.staff_id, l.name);
  const lineStatus = new Map(lines.map((l) => [l.staff_id, l.status]));
  const forWise = wiseLines(lines);
  const noEmail = forWise.filter((l) => !l.email).map((l) => l.name);
  const freelancers = people.filter((p) => p.pay_type === "freelance" || p.role === "freelance");
  const saved = typeof params.saved === "string" ? SAVED[params.saved] : undefined;
  const error = typeof params.error === "string" ? ERRORS[params.error] : undefined;
  const weekField = <input type="hidden" name="week" value={week} />;

  return (
    <div className="flex flex-col gap-6 p-4">
      <div>
        <h1 className="text-lg font-semibold">Payroll</h1>
        <p className="text-xs text-muted">Owner only. Weeks run Monday to Sunday in New York time; a shift belongs to the week it starts in.</p>
        {error ? <p className="mt-2 rounded bg-bad-bg px-3 py-2 text-bad">{error}</p> : null}
        {saved ? <p className="mt-2 rounded bg-good-bg px-3 py-2 text-good">{saved}</p> : null}
      </div>

      {gaps.length > 0 ? (
        <section className="rounded border border-line bg-bad-bg px-3 py-2">
          <h2 className="font-semibold text-bad">Before the first run</h2>
          <p className="text-xs text-muted">These people cannot be paid until this is entered under Pay settings below. They are never paid $0 by default.</p>
          <ul className="mt-1 list-disc pl-5">
            {gaps.map((g) => (
              <li key={g.staff_id}>
                {g.name}: {g.problem === "no pay type" ? "no pay type" : g.pay_type === "hourly" ? "no hourly rate" : "no monthly amount"}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-wrap items-center gap-3">
        <Link href={`/payroll?week=${addDays(week, -7)}`} className={quiet}>← Previous</Link>
        <span className="font-semibold">Week of {dayMonth(week)} to {formatDay(weekEnd)}</span>
        <Link href={`/payroll?week=${addDays(week, 7)}`} className={quiet}>Next →</Link>
        <form action="/payroll" className="flex items-center gap-1">
          <input type="date" name="week" defaultValue={week} aria-label="Any day in the week" className={input} />
          <button type="submit" className={quiet}>Go</button>
        </form>
        {run ? <StatusPill status={run.status} /> : <span className="text-muted">no run built</span>}
      </section>

      <section className="flex flex-wrap items-center gap-2">
        <form action={rebuildPayRun}>
          {weekField}
          <button type="submit" className={button}>{run ? "Rebuild draft" : "Build draft"}</button>
        </form>
        {run && run.draft_lines > 0 ? (
          <form action={approveAllPayLines}>
            {weekField}
            <input type="hidden" name="run_id" value={run.id} />
            <button type="submit" className={button}>Approve all</button>
          </form>
        ) : null}
        {run && run.status !== "draft" && run.approved_lines > 0 ? (
          <form action={markPayRunPaid}>
            {weekField}
            <input type="hidden" name="run_id" value={run.id} />
            <button type="submit" className={button}>Mark paid</button>
          </form>
        ) : null}
        {run && forWise.length > 0 ? (
          <a href={`/api/payroll/${run.id}/wise.csv`} className={quiet}>Wise CSV ({forWise.length})</a>
        ) : null}
        {run ? (
          <span className="text-muted">
            {usd(run.total)} across {run.people} {run.people === 1 ? "person" : "people"} · {run.flag_count} {run.flag_count === 1 ? "flag" : "flags"}
            {run.paid_at ? ` · paid ${formatDay(run.paid_at)}` : run.approved_at ? ` · approved ${formatDay(run.approved_at)}` : ""}
          </span>
        ) : null}
      </section>
      {run ? (
        <p className="-mt-4 text-xs text-muted">
          Rebuild recomputes draft lines only; approved and paid lines never change. Approve all skips anyone with no rate or no pay type.
          {noEmail.length > 0 ? <span className="text-bad"> No email on file for {noEmail.join(", ")}: their row in the Wise file has a blank email.</span> : null}
        </p>
      ) : null}

      {run ? (
        <section>
          <div className="overflow-x-auto rounded border border-line bg-panel">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-xs text-muted">
                <tr>
                  <th className="px-3 py-2">Person</th>
                  <th className="px-3 py-2 text-right">Rostered h</th>
                  <th className="px-3 py-2 text-right">Worked h</th>
                  <th className="px-3 py-2 text-right">Late</th>
                  <th className="px-3 py-2 text-right">No-shows</th>
                  <th className="px-3 py-2 text-right">Rate</th>
                  <th className="px-3 py-2 text-right">Gross</th>
                  <th className="px-3 py-2">Adjustment</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Flags</th>
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 ? (
                  <tr><td colSpan={11} className="px-3 py-3 text-muted">Nobody is on this run.</td></tr>
                ) : null}
                {lines.map((l) => (
                  <tr key={l.id} className="border-b border-line align-top last:border-0">
                    <td className="px-3 py-2 font-medium">
                      {l.name}
                      <div className="text-xs font-normal text-muted">{l.pay_type ? PAY_TYPE[l.pay_type] : "no pay type"}</div>
                    </td>
                    <td className="px-3 py-2 text-right">{hours(l.rostered_hours)}</td>
                    <td className="px-3 py-2 text-right">{hours(l.worked_hours)}</td>
                    <td className={`px-3 py-2 text-right ${l.late_count > 0 ? "text-warn" : ""}`}>{l.late_count}</td>
                    <td className={`px-3 py-2 text-right ${l.no_show_count > 0 ? "text-bad" : ""}`}>{l.no_show_count}</td>
                    <td className="px-3 py-2 text-right">{rateText(l)}</td>
                    <td className="px-3 py-2 text-right">
                      <Money value={l.gross} missing="cannot be worked out" />
                      {l.note ? <div className="text-xs text-muted">{l.note}</div> : null}
                    </td>
                    <td className="px-3 py-2">
                      {l.status === "draft" ? (
                        <form action={setPayAdjustment} className="flex flex-wrap items-center gap-1">
                          {weekField}
                          <input type="hidden" name="line_id" value={l.id} />
                          <input type="number" step="0.01" name="amount" defaultValue={l.adjustment === 0 ? "" : l.adjustment} placeholder="+/− $" aria-label={`${l.name} adjustment amount`} className={`${input} w-24`} />
                          <input name="reason" defaultValue={l.adjustment_reason ?? ""} placeholder="Reason (required)" maxLength={300} aria-label={`${l.name} adjustment reason`} className={`${input} w-40`} />
                          <button type="submit" className={quiet}>Save</button>
                        </form>
                      ) : l.adjustment !== 0 ? (
                        <span>{l.adjustment > 0 ? "+" : ""}{usd(l.adjustment)} <span className="text-xs text-muted">{l.adjustment_reason}</span></span>
                      ) : (
                        <span className="text-muted">none</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold">{usd(l.total)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <StatusPill status={l.status} />
                        {l.status === "draft" && l.gross !== null ? (
                          <form action={approvePayLine}>
                            {weekField}
                            <input type="hidden" name="line_id" value={l.id} />
                            <button type="submit" className={quiet}>Approve</button>
                          </form>
                        ) : null}
                      </div>
                      {l.paid_at ? <div className="text-xs text-muted">{formatDay(l.paid_at)}</div> : null}
                    </td>
                    <td className="px-3 py-2">
                      {l.flags.length === 0 ? <span className="text-muted">none</span> : (
                        <div className="flex flex-wrap gap-1">
                          {l.flags.map((f) => <span key={f} className="rounded bg-bad-bg px-1.5 py-0.5 text-xs text-bad">{f}</span>)}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <p className="rounded border border-line bg-panel px-3 py-3 text-muted">
          No pay run has been built for this week. Build draft computes it from attendance, the roster and pay settings.
        </p>
      )}

      <section>
        <h2 className="mb-1 font-semibold">Attendance days and overtime</h2>
        <p className="mb-2 text-xs text-muted">
          Hourly pay counts clock-in to clock-out inside the rostered shift. Tick overtime to pay a day&apos;s full clock-in to clock-out. Times are New York time.
        </p>
        <div className="overflow-x-auto rounded border border-line bg-panel">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th className="px-3 py-2">Person</th>
                <th className="px-3 py-2">Day</th>
                <th className="px-3 py-2">Shift</th>
                <th className="px-3 py-2">Clocked</th>
                <th className="px-3 py-2">Attendance</th>
                <th className="px-3 py-2 text-right">Paid h</th>
                <th className="px-3 py-2">Overtime approved</th>
              </tr>
            </thead>
            <tbody>
              {days.length === 0 ? (
                <tr><td colSpan={7} className="px-3 py-3 text-muted">No attendance recorded for this week.</td></tr>
              ) : null}
              {days.map((d) => {
                const locked = (lineStatus.get(d.staff_id) ?? "draft") !== "draft";
                return (
                  <tr key={d.attendance_id} className="border-b border-line last:border-0">
                    <td className="px-3 py-2 font-medium">{nameOf.get(d.staff_id) ?? "Unknown"}</td>
                    <td className="px-3 py-2">{dayMonth(d.date)}</td>
                    <td className="px-3 py-2">{d.shift_start && d.shift_end ? `${etTime(d.shift_start)} to ${etTime(d.shift_end)}` : <span className="text-bad">not rostered</span>}</td>
                    <td className="px-3 py-2">
                      {d.clock_in ? `${etTime(d.clock_in)} to ${etTime(d.clock_out) ?? "no clock-out"}` : <span className="text-muted">no clock-in</span>}
                      {d.overtime_unapproved ? <span className="ml-2 text-xs text-warn">past the shift</span> : null}
                    </td>
                    <td className="px-3 py-2">{d.status ? d.status.replace("_", " ") : <span className="text-muted">not decided</span>}</td>
                    <td className="px-3 py-2 text-right">{hours(d.worked_minutes / 60)}</td>
                    <td className="px-3 py-2">
                      {locked ? (
                        <span className="text-muted">{d.overtime_approved ? "yes" : "no"} (line {lineStatus.get(d.staff_id)})</span>
                      ) : (
                        <form action={setOvertimeApproved} className="flex items-center gap-2">
                          {weekField}
                          <input type="hidden" name="attendance_id" value={d.attendance_id ?? ""} />
                          <input type="checkbox" name="approved" defaultChecked={d.overtime_approved} aria-label={`Approve overtime for ${nameOf.get(d.staff_id) ?? "this person"} on ${dayMonth(d.date)}`} />
                          <button type="submit" className={quiet}>Save</button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Freelance jobs this week</h2>
        <div className="overflow-x-auto rounded border border-line bg-panel">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th className="px-3 py-2">Person</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Job</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">Pay run</th>
              </tr>
            </thead>
            <tbody>
              {jobs.length === 0 ? (
                <tr><td colSpan={5} className="px-3 py-3 text-muted">No freelance jobs dated in this week.</td></tr>
              ) : null}
              {jobs.map((j) => (
                <tr key={j.id} className="border-b border-line last:border-0">
                  <td className="px-3 py-2 font-medium">{nameOf.get(j.staff_id) ?? "Unknown"}</td>
                  <td className="px-3 py-2">{dayMonth(j.date)}</td>
                  <td className="px-3 py-2">{j.description}</td>
                  <td className="px-3 py-2 text-right">{usd(j.amount)}</td>
                  <td className="px-3 py-2">
                    {j.pay_run_id ? "on a run" : <span className="text-warn">not on a run yet{lineStatus.get(j.staff_id) && lineStatus.get(j.staff_id) !== "draft" ? ": this week's line is already approved, so re-date it to an open week" : ""}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {freelancers.length > 0 ? (
          <form action={addFreelanceJob} className="mt-2 flex flex-wrap items-center gap-2">
            {weekField}
            <select name="staff_id" aria-label="Freelancer" className={input} required>
              {freelancers.map((f) => <option key={f.staff_id} value={f.staff_id}>{f.name}</option>)}
            </select>
            <input type="date" name="date" defaultValue={week} min={week} max={weekEnd} aria-label="Job date" className={input} required />
            <input name="description" placeholder="What was done" maxLength={300} aria-label="Job description" className={`${input} w-64`} required />
            <input type="number" step="0.01" min="0.01" name="amount" placeholder="Amount $" aria-label="Job amount" className={`${input} w-28`} required />
            <button type="submit" className={button}>Add job</button>
          </form>
        ) : (
          <p className="mt-2 text-xs text-muted">Nobody is set to freelance pay. Set a pay type below to add jobs.</p>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Pay settings</h2>
        <div className="overflow-x-auto rounded border border-line bg-panel">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th className="px-3 py-2">Person</th>
                <th className="px-3 py-2">Pay type, hourly rate ($) and monthly amount ($)</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.staff_id} className="border-b border-line last:border-0">
                  <td className="px-3 py-2 font-medium">{p.name} <span className="text-xs font-normal text-muted">{p.role.replaceAll("_", " ")}</span></td>
                  <td className="px-3 py-2">
                    <form action={updatePay} className="flex flex-wrap items-center gap-2">
                      {weekField}
                      <input type="hidden" name="staff_id" value={p.staff_id} />
                      <select name="pay_type" defaultValue={p.pay_type ?? ""} aria-label={`${p.name} pay type`} className={input}>
                        <option value="">Not set</option>
                        <option value="hourly">Hourly</option>
                        <option value="fixed_monthly">Fixed monthly</option>
                        <option value="freelance">Freelance</option>
                      </select>
                      <input type="number" step="0.01" min="0" name="hourly_rate" defaultValue={p.hourly_rate ?? ""} placeholder="Hourly rate" aria-label={`${p.name} hourly rate`} className={`${input} w-28`} />
                      <input type="number" step="0.01" min="0" name="monthly_amount" defaultValue={p.monthly_amount ?? ""} placeholder="Monthly amount" aria-label={`${p.name} monthly amount`} className={`${input} w-32`} />
                      <button type="submit" className={quiet}>Save</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
