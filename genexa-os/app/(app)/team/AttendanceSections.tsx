import { addOverride, editAttendance, removeOverride } from "@/lib/actions/attendance";
import {
  getAttendanceLog,
  getAttendanceToday,
  getAttendanceWeeks,
  getShiftOverrides,
  type AttendanceWeekCell,
} from "@/lib/queries/attendance";
import type { TeamMember } from "@/lib/queries/team";

const STATE: Record<string, { label: string; className: string }> = {
  on_time: { label: "On time", className: "bg-good-bg text-good" },
  late: { label: "Late", className: "bg-warn-bg text-warn" },
  no_show: { label: "No-show", className: "bg-bad-bg text-bad" },
  excused: { label: "Excused", className: "bg-stale-bg text-muted" },
  off: { label: "Not working", className: "bg-stale-bg text-muted" },
  not_started: { label: "Not started", className: "bg-stale-bg text-muted" },
  due: { label: "Due, not clocked in", className: "bg-warn-bg text-warn" },
};
const COLOUR: Record<string, string> = { green: "text-good", amber: "text-warn", red: "text-bad" };
const KIND: Record<string, string> = { sick: "Sick", holiday: "Holiday", swap: "Swap", custom: "Custom" };
const ERRORS: Record<string, string> = {
  note: "An attendance edit needs a note saying why.",
  times: "Clock out cannot be before clock in.",
  edit_invalid: "Check the status and the times.",
  edit_save: "The attendance row could not be saved.",
  override_invalid: "Pick a person, a date and a kind.",
  override_both_times: "Enter both a start and an end time, or leave both blank.",
  override_no_hours: "A sick day or holiday has no hours. Use swap or custom to change hours.",
  override_exists: "That person already has an override on that date. Remove it first.",
  override_save: "The override could not be saved.",
};
const SAVED: Record<string, string> = {
  edit: "Attendance row saved.",
  override: "Override added.",
  override_removed: "Override removed.",
};

const day = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const input = "rounded border border-line px-1.5 py-1";

function Pill({ state }: { state: string | null }) {
  const s = state ? STATE[state] : undefined;
  return s ? <span className={`rounded px-1.5 py-0.5 text-xs ${s.className}`}>{s.label}</span> : <span className="text-muted">no data</span>;
}

function WeekCell({ cell }: { cell: AttendanceWeekCell | undefined }) {
  if (!cell || cell.pct === null) return <td className="px-3 py-2 text-muted">no data</td>;
  return (
    <td className="px-3 py-2" title={`${cell.on_time} on time of ${cell.rostered} rostered shifts`}>
      <span className={`font-medium ${cell.colour ? COLOUR[cell.colour] : ""}`}>{cell.pct}%</span>
      <span className="ml-2 text-xs text-muted">
        {cell.late ?? 0} late · <span className={cell.no_shows ? "font-semibold text-bad" : ""}>{cell.no_shows ?? 0} no-show</span>
      </span>
    </td>
  );
}

/** Attendance and shift overrides on the Team page. Display only: every figure comes from lib/queries/attendance. */
export async function AttendanceSections({
  team,
  isOwner,
  error,
  saved,
}: {
  team: TeamMember[];
  isOwner: boolean;
  error?: string;
  saved?: string;
}) {
  const [today, weeks, log, overrides] = await Promise.all([
    getAttendanceToday(),
    getAttendanceWeeks(5),
    isOwner ? getAttendanceLog(14) : Promise.resolve([]),
    isOwner ? getShiftOverrides() : Promise.resolve([]),
  ]);
  const nameOf = new Map(team.map((t) => [t.id, t.name]));
  const scored = team.filter((t) => weeks.people.some((p) => p.staff_id === t.id));

  return (
    <>
      {error && ERRORS[error] ? <p className="rounded bg-bad-bg px-3 py-2 text-bad">{ERRORS[error]}</p> : null}
      {saved && SAVED[saved] ? <p className="rounded bg-good-bg px-3 py-2 text-good">{SAVED[saved]}</p> : null}

      <section id="attendance-today">
        <h2 className="mb-1 font-semibold">Today</h2>
        <p className="mb-2 text-xs text-muted">Everyone rostered today. Times are in each person&apos;s own timezone.</p>
        <div className="overflow-x-auto rounded border border-line bg-panel">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Shift</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Clocked in</th>
                <th className="px-3 py-2">Clocked out</th>
              </tr>
            </thead>
            <tbody>
              {today.length === 0 ? (
                <tr><td colSpan={5} className="px-3 py-3 text-muted">Nobody is rostered today.</td></tr>
              ) : today.map((t) => (
                <tr key={t.staff_id} className="border-b border-line last:border-0">
                  <td className="px-3 py-2 font-medium">{t.name}</td>
                  <td className="px-3 py-2">
                    {t.shift_label ?? <span className="text-muted">{t.override_kind ? KIND[t.override_kind] : "—"}</span>}
                    {t.shift_label && t.override_kind ? <span className="ml-2 text-xs text-muted">{KIND[t.override_kind]}</span> : null}
                    <span className="ml-2 text-xs text-muted">{t.timezone}</span>
                  </td>
                  <td className="px-3 py-2">
                    <Pill state={t.state} />
                    {t.minutes_late ? <span className="ml-2 text-xs text-muted">{t.minutes_late} min late</span> : null}
                    {t.manual ? <span className="ml-2 text-xs text-muted">edited by owner</span> : null}
                  </td>
                  <td className="px-3 py-2">{t.clock_in_label ?? <span className="text-muted">—</span>}</td>
                  <td className="px-3 py-2">{t.clock_out_label ?? <span className="text-muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section id="attendance-weeks">
        <h2 className="mb-1 font-semibold">Attendance by week</h2>
        <p className="mb-2 text-xs text-muted">
          On-time shifts ÷ rostered shifts (excused shifts left out), Mon–Sun ET. Any no-show makes the week red. Weeks before go-live are tracked but not coloured.
        </p>
        <div className="overflow-x-auto rounded border border-line bg-panel">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th className="px-3 py-2">Name</th>
                {weeks.weeks.map((w, i) => <th key={w} className="px-3 py-2">{i === 0 ? "This week" : `w/c ${day(w)}`}</th>)}
              </tr>
            </thead>
            <tbody>
              {scored.length === 0 ? (
                <tr><td colSpan={weeks.weeks.length + 1} className="px-3 py-3 text-muted">No data.</td></tr>
              ) : scored.map((t) => {
                const cells = weeks.people.find((p) => p.staff_id === t.id)?.cells ?? [];
                return (
                  <tr key={t.id} className="border-b border-line last:border-0">
                    <td className="px-3 py-2 font-medium">{t.name}</td>
                    {weeks.weeks.map((w) => <WeekCell key={w} cell={cells.find((c) => c.week_start === w)} />)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {isOwner ? (
        <section id="attendance-log">
          <h2 className="mb-1 font-semibold">Attendance log, last 14 days</h2>
          <p className="mb-2 text-xs text-muted">
            Open a row to correct it. An edit needs a note, is recorded in the audit log, and is never overwritten by the automatic status check.
          </p>
          <div className="rounded border border-line bg-panel">
            {log.length === 0 ? <p className="px-3 py-3 text-muted">No attendance rows yet.</p> : log.map((a) => (
              <details key={a.id} className="border-b border-line last:border-0">
                <summary className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
                  <span className="w-24 text-muted">{day(a.date)}</span>
                  <span className="w-44 font-medium">{a.name}</span>
                  <span className="w-28">{a.shift_label ?? <span className="text-muted">not rostered</span>}</span>
                  <Pill state={a.status} />
                  <span className="text-xs text-muted">
                    in {a.clock_in_label ?? "—"} · out {a.clock_out_label ?? "—"}
                    {a.minutes_late ? ` · ${a.minutes_late} min late` : ""}
                    {a.overtime_approved ? " · overtime approved" : ""}
                    {a.manual ? ` · edited${a.approved_by_name ? ` by ${a.approved_by_name}` : ""}` : ""}
                  </span>
                  {a.note ? <span className="text-xs text-muted">“{a.note}”</span> : null}
                </summary>
                <form action={editAttendance} className="flex flex-wrap items-end gap-3 px-3 pb-3 text-xs">
                  <input type="hidden" name="id" value={a.id} />
                  <label className="flex flex-col gap-1">
                    Status
                    <select name="status" defaultValue={a.status ?? ""} className={input}>
                      <option value="">not decided</option>
                      <option value="on_time">On time</option>
                      <option value="late">Late</option>
                      <option value="no_show">No-show</option>
                      <option value="excused">Excused</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    Clock in ({a.timezone})
                    <input type="datetime-local" name="clock_in" defaultValue={a.clock_in_local ?? ""} className={input} />
                  </label>
                  <label className="flex flex-col gap-1">
                    Clock out ({a.timezone})
                    <input type="datetime-local" name="clock_out" defaultValue={a.clock_out_local ?? ""} className={input} />
                  </label>
                  <label className="flex items-center gap-1.5 pb-1.5">
                    <input type="checkbox" name="overtime_approved" defaultChecked={a.overtime_approved} />
                    Overtime approved
                  </label>
                  <label className="flex min-w-64 flex-1 flex-col gap-1">
                    Note (required)
                    <input name="note" required maxLength={500} defaultValue={a.note ?? ""} className={input} />
                  </label>
                  <button type="submit" className="cursor-pointer rounded bg-accent px-2 py-1.5 font-medium text-white">Save</button>
                </form>
              </details>
            ))}
          </div>
        </section>
      ) : null}

      {isOwner ? (
        <section id="overrides">
          <h2 className="mb-1 font-semibold">Shift overrides</h2>
          <p className="mb-2 text-xs text-muted">
            A one-day change. Sick and holiday excuse the day. Swap and custom set different hours for that day (in the person&apos;s own time), or no hours to
            release them.
          </p>
          <form action={addOverride} className="mb-3 flex flex-wrap items-end gap-3 rounded border border-line bg-panel p-3 text-xs">
            <label className="flex flex-col gap-1">
              Person
              <select name="staff_id" required defaultValue="" className={input}>
                <option value="" disabled>Choose</option>
                {team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              Date
              <input type="date" name="date" required className={input} />
            </label>
            <label className="flex flex-col gap-1">
              Kind
              <select name="kind" defaultValue="sick" className={input}>
                {Object.entries(KIND).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              Start (swap / custom)
              <input type="time" name="shift_start" className={input} />
            </label>
            <label className="flex flex-col gap-1">
              End
              <input type="time" name="shift_end" className={input} />
            </label>
            <label className="flex min-w-56 flex-1 flex-col gap-1">
              Note
              <input name="note" maxLength={500} className={input} />
            </label>
            <button type="submit" className="cursor-pointer rounded bg-accent px-2 py-1.5 font-medium text-white">Add override</button>
          </form>
          <div className="overflow-x-auto rounded border border-line bg-panel">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-xs text-muted">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Person</th>
                  <th className="px-3 py-2">Kind</th>
                  <th className="px-3 py-2">Hours that day</th>
                  <th className="px-3 py-2">Note</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {overrides.length === 0 ? (
                  <tr><td colSpan={6} className="px-3 py-3 text-muted">No overrides in the last 14 days or ahead.</td></tr>
                ) : overrides.map((o) => (
                  <tr key={o.id} className={`border-b border-line last:border-0 ${o.upcoming ? "" : "text-muted"}`}>
                    <td className="px-3 py-2">{day(o.date)}{o.upcoming ? null : <span className="ml-2 text-xs">past</span>}</td>
                    <td className="px-3 py-2 font-medium">{nameOf.get(o.staff_id) ?? "—"}</td>
                    <td className="px-3 py-2">{KIND[o.kind]}</td>
                    <td className="px-3 py-2">{o.shift_start && o.shift_end ? `${o.shift_start.slice(0, 5)}–${o.shift_end.slice(0, 5)}` : "Not working"}</td>
                    <td className="px-3 py-2">{o.note ?? "—"}</td>
                    <td className="px-3 py-2 text-right">
                      <form action={removeOverride}>
                        <input type="hidden" name="id" value={o.id} />
                        <button type="submit" className="cursor-pointer rounded border border-line px-2 py-1 text-xs">Remove</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}
