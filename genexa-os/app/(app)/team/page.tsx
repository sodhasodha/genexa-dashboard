import { resetPassword, updateShift } from "@/lib/actions/team";
import { requireStaff } from "@/lib/auth/staff";
import { getCoverage, getTeam, type CoverageHour } from "@/lib/queries/team";
import { AttendanceSections } from "./AttendanceSections";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TIMEZONES = ["America/New_York", "America/Chicago", "America/Los_Angeles", "Europe/London", "Asia/Manila", "Asia/Kolkata", "Asia/Karachi", "Asia/Dubai"];
const ERRORS: Record<string, string> = {
  no_login: "That person has no login to reset.",
  password: "The password could not be reset.",
  invalid: "Check the times (HH:MM) and the timezone.",
  both_times: "Enter both a start and an end time, or leave both blank.",
  timezone: "That is not a timezone name. Use one like Asia/Manila.",
  save: "The shift could not be saved.",
};
const ROLE_LABEL: Record<string, string> = { owner: "Owner", media_buyer: "Media buyer", tech: "Tech", csr: "CSR", freelance: "Freelance" };

function cellClass(h: CoverageHour): string {
  if (h.csr_gap) return "bg-bad-bg text-bad font-semibold";
  if (h.csrs_on > 0) return h.cover_expected ? "bg-good-bg text-good" : "bg-stale-bg text-ink";
  return "text-muted";
}

export default async function TeamPage({ searchParams }: PageProps<"/team">) {
  const me = await requireStaff();
  const params = await searchParams;
  const [team, coverage] = await Promise.all([getTeam(), getCoverage()]);
  const isOwner = me.role === "owner";
  const noShift = team.filter((t) => t.role !== "owner" && t.role !== "freelance" && !t.shift_start);
  const gaps = coverage.filter((h) => h.csr_gap).length;
  const error = typeof params.error === "string" ? ERRORS[params.error] : undefined;

  return (
    <div className="flex flex-col gap-6 p-4">
      <div>
        <h1 className="text-lg font-semibold">Team</h1>
        {noShift.length > 0 ? (
          <p className="mt-2 rounded bg-bad-bg px-3 py-2 text-bad">
            No shift entered for {noShift.map((t) => t.name).join(", ")}. Reminders are held to each person&apos;s shift, so these
            people receive none until a shift is set.
          </p>
        ) : null}
        {error ? <p className="mt-2 rounded bg-bad-bg px-3 py-2 text-bad">{error}</p> : null}
        {params.saved === "1" ? <p className="mt-2 rounded bg-good-bg px-3 py-2 text-good">Shift saved.</p> : null}
        {params.saved === "password" ? (
          <p className="mt-2 rounded bg-good-bg px-3 py-2 text-good">Password reset to their first name{typeof params.who === "string" ? ` (${params.who})` : ""}.</p>
        ) : null}
      </div>

      <section>
        <h2 className="mb-2 font-semibold">Shift rota</h2>
        <div className="overflow-x-auto rounded border border-line bg-panel">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Role</th>
                <th className="px-3 py-2">Pod</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Shift (their local time), timezone and working days</th>
              </tr>
            </thead>
            <tbody>
              {team.map((t) => (
                <tr key={t.id} className="border-b border-line last:border-0 align-top">
                  <td className="px-3 py-2 font-medium">
                    {t.name}
                    {!t.has_login ? <span className="ml-2 text-xs font-normal text-muted">no login</span> : null}
                    {isOwner && t.has_login && t.role !== "owner" ? (
                      <form action={resetPassword} className="mt-1">
                        <input type="hidden" name="staff_id" value={t.id} />
                        <button type="submit" className="cursor-pointer rounded border border-line px-2 py-0.5 text-xs font-normal text-muted hover:text-ink" title="Sets the password back to their first name">Reset password</button>
                      </form>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    {ROLE_LABEL[t.role] ?? t.role}
                    {t.also_role ? <span className="text-muted"> + {t.also_role.replaceAll("_", " ")}</span> : null}
                  </td>
                  <td className="px-3 py-2">{t.pod ? t.pod.replace("pod_", "Pod ") : "—"}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-1.5 py-0.5 text-xs ${t.status === "at_risk" ? "bg-bad-bg text-bad" : t.status === "trial" ? "bg-warn-bg text-warn" : "bg-good-bg text-good"}`}>
                      {t.status.replace("_", " ")}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {isOwner ? (
                      <form action={updateShift} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="staff_id" value={t.id} />
                        <input type="time" name="shift_start" defaultValue={t.shift_start?.slice(0, 5) ?? ""} aria-label={`${t.name} shift start`} className="rounded border border-line px-1.5 py-1" />
                        <span>to</span>
                        <input type="time" name="shift_end" defaultValue={t.shift_end?.slice(0, 5) ?? ""} aria-label={`${t.name} shift end`} className="rounded border border-line px-1.5 py-1" />
                        <input name="timezone" list="timezones" defaultValue={t.timezone} aria-label={`${t.name} timezone`} className="w-44 rounded border border-line px-1.5 py-1" />
                        <span className="flex gap-1.5">
                          {DAYS.map((d, i) => (
                            <label key={d} className="flex items-center gap-0.5 text-xs">
                              <input type="checkbox" name="working_days" value={i + 1} defaultChecked={t.working_days.includes(i + 1)} />
                              {d}
                            </label>
                          ))}
                        </span>
                        <button type="submit" className="cursor-pointer rounded bg-accent px-2 py-1 text-xs font-medium text-white">Save</button>
                      </form>
                    ) : t.shift_start && t.shift_end ? (
                      <span>
                        {t.shift_start.slice(0, 5)} to {t.shift_end.slice(0, 5)} {t.timezone} · {DAYS.filter((_, i) => t.working_days.includes(i + 1)).join(" ")}
                      </span>
                    ) : (
                      <span className="text-muted">no shift entered</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <datalist id="timezones">
            {TIMEZONES.map((z) => <option key={z} value={z} />)}
          </datalist>
        </div>
      </section>

      <AttendanceSections
        team={team}
        isOwner={isOwner}
        error={typeof params.att_error === "string" ? params.att_error : undefined}
        saved={typeof params.att_saved === "string" ? params.att_saved : undefined}
      />

      <section>
        <h2 className="mb-1 font-semibold">CSR coverage this week (ET)</h2>
        <p className="mb-2 text-xs text-muted">
          Number of CSRs on shift each hour. Hover a cell for names.{" "}
          {gaps > 0 ? <span className="font-semibold text-bad">{gaps} hours with no CSR inside the expected window.</span> : "No gaps inside the expected window."}
        </p>
        <div className="overflow-x-auto rounded border border-line bg-panel">
          <table className="text-center text-xs">
            <thead className="text-muted">
              <tr>
                <th className="px-2 py-1 text-left">ET hour</th>
                {Array.from({ length: 24 }, (_, h) => <th key={h} className="w-8 px-1 py-1 font-normal">{String(h).padStart(2, "0")}</th>)}
              </tr>
            </thead>
            <tbody>
              {DAYS.map((d, i) => (
                <tr key={d} className="border-t border-line">
                  <th className="px-2 py-1 text-left font-medium">{d}</th>
                  {coverage.filter((h) => h.isodow === i + 1).map((h) => (
                    <td key={h.et_hour} title={h.who ?? "nobody on"} className={`px-1 py-1 ${cellClass(h)}`}>
                      {h.csrs_on}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
