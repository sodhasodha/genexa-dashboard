import Link from "next/link";
import { CsrFields, MediaBuyerFields, TechFields } from "@/components/eod/EodForms";
import { saveEod } from "@/lib/actions/eod";
import { requireStaff } from "@/lib/auth/staff";
import { EOD_ERRORS, isEodRole, type EodRole } from "@/lib/eod/schema";
import { getEodDetail, getEodForm, getEodStatusBoard, getMyRecentEods, type EodForm, type EodStatusCell } from "@/lib/queries/eod";

const ROLE_LABEL: Record<string, string> = { owner: "Owner", media_buyer: "Media buyer", tech: "Tech", csr: "CSR", freelance: "Freelance" };
const CELL: Record<EodStatusCell["state"], { text: string; className: string }> = {
  filed: { text: "Filed", className: "bg-good-bg text-good" },
  missing: { text: "Missing", className: "bg-bad-bg text-bad font-semibold" },
  due: { text: "Due today", className: "bg-warn-bg text-warn" },
};

const readHref = (staffId: string, day: string) => `/eod?staff=${staffId}&day=${day}#read`;

function Fields({ role, form }: { role: EodRole; form: EodForm }) {
  const saved = form.existing?.eod ?? null;
  if (role === "csr") return <CsrFields saved={saved?.role === "csr" ? saved.answers : null} shiftHours={form.shiftHours} />;
  if (role === "media_buyer") {
    return <MediaBuyerFields saved={saved?.role === "media_buyer" ? saved.answers : null} clients={form.clients} exceptions={form.exceptions} />;
  }
  return <TechFields saved={saved?.role === "tech" ? saved.answers : null} jobs={form.jobs} />;
}

export default async function EodPage({ searchParams }: PageProps<"/eod">) {
  const me = await requireStaff();
  const params = await searchParams;
  const isOwner = me.role === "owner";
  const role: EodRole | null = isEodRole(me.role) ? me.role : null;
  const hasForm = role !== null;
  const readStaff = typeof params.staff === "string" ? params.staff : null;
  const readDay = typeof params.day === "string" ? params.day : null;

  const [form, recent, board, detail] = await Promise.all([
    role ? getEodForm(me) : null,
    getMyRecentEods(me),
    isOwner ? getEodStatusBoard(me) : null,
    readStaff && readDay ? getEodDetail(me, readStaff, readDay) : null,
  ]);
  const error = typeof params.error === "string" ? (EOD_ERRORS[params.error] ?? EOD_ERRORS.save) : undefined;

  return (
    <div className="flex max-w-4xl flex-col gap-6 p-4">
      <div>
        <h1 className="text-lg font-semibold">End of day</h1>
        {error ? <p className="mt-2 rounded bg-bad-bg px-3 py-2 text-bad">{error}</p> : null}
        {params.saved === "1" ? <p className="mt-2 rounded bg-good-bg px-3 py-2 text-good">EOD saved. You can change it until midnight your time.</p> : null}
      </div>

      {form && role ? (
        <section>
          <h2 className="font-semibold">
            {form.existing ? "Edit" : "File"} your EOD for {form.dayLabel}
          </h2>
          <p className="mb-3 text-xs text-muted">
            Filed as {me.name} ({ROLE_LABEL[me.role]}).{" "}
            {form.existing
              ? `Submitted ${form.existing.submitted} (${me.timezone}). You can change it until midnight your time.`
              : `One EOD per day, open until midnight your time (${me.timezone}).`}
            {form.existing && !form.existing.eod ? " It was filed in an older format, so the form starts blank." : ""}
          </p>
          <form action={saveEod} className="flex flex-col gap-4 rounded border border-line bg-panel p-4">
            <input type="hidden" name="date" value={form.date} />
            <Fields role={role} form={form} />
            <div>
              <button type="submit" className="cursor-pointer rounded bg-accent px-3 py-1.5 font-medium text-white">
                {form.existing ? "Save changes" : "File EOD"}
              </button>
            </div>
          </form>
        </section>
      ) : (
        <p className="rounded border border-line bg-panel px-4 py-3 text-muted">
          There is no EOD for your role ({ROLE_LABEL[me.role]}). EODs are filed by CSRs, media buyers and tech.
        </p>
      )}

      {detail || (readStaff && readDay) ? (
        <section id="read">
          <h2 className="mb-2 font-semibold">{detail ? `${detail.name} · ${detail.day}` : "EOD"}</h2>
          {detail ? (
            <div className="rounded border border-line bg-panel">
              <p className="border-b border-line px-3 py-2 text-xs text-muted">
                {ROLE_LABEL[detail.role] ?? detail.role} · submitted {detail.submitted} ({me.timezone})
              </p>
              <dl>
                {detail.lines.map((l) => (
                  <div key={l.label} className="flex flex-col gap-0.5 border-b border-line px-3 py-2 last:border-0 sm:flex-row sm:gap-4">
                    <dt className="shrink-0 text-muted sm:w-48">{l.label}</dt>
                    <dd className="whitespace-pre-wrap break-words">{l.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : (
            <p className="rounded border border-line bg-panel px-4 py-3 text-muted">No EOD was filed for that person on that day.</p>
          )}
        </section>
      ) : null}

      {hasForm || recent.length > 0 ? (
        <section>
          <h2 className="mb-2 font-semibold">Your last 7 EODs</h2>
          {recent.length === 0 ? (
            <p className="rounded border border-line bg-panel px-4 py-6 text-muted">You have not filed an EOD yet.</p>
          ) : (
            <div className="overflow-x-auto rounded border border-line bg-panel">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-line text-xs text-muted">
                  <tr>
                    <th className="px-3 py-2 font-normal">Date</th>
                    <th className="px-3 py-2 font-normal">Submitted ({me.timezone})</th>
                    <th className="px-3 py-2 font-normal">Summary</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {recent.map((e) => (
                    <tr key={e.id} className="border-b border-line last:border-0">
                      <td className="whitespace-nowrap px-3 py-1.5">{e.day}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">{e.submitted}</td>
                      <td className="px-3 py-1.5">{e.summary}</td>
                      <td className="px-3 py-1.5 text-right">
                        <Link href={readHref(me.id, e.date)} className="text-accent hover:underline">Read</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {board ? (
        <section>
          <h2 className="mb-1 font-semibold">Everyone, last 7 days</h2>
          {board.goLive === null ? (
            <p className="rounded border border-line bg-panel px-4 py-6 text-muted">EOD tracking starts once a go-live date is set.</p>
          ) : board.people.length === 0 ? (
            <p className="rounded border border-line bg-panel px-4 py-6 text-muted">
              EOD tracking starts on the go-live date, {board.goLiveLabel}. Nobody has been expected to file yet.
            </p>
          ) : (
            <>
              <p className="mb-2 text-xs text-muted">
                Only days each person was due to work, from the go-live date ({board.goLiveLabel}). Each day is that person&apos;s own
                calendar day. Open a filed day to read it.
              </p>
              <div className="overflow-x-auto rounded border border-line bg-panel">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-line text-xs text-muted">
                    <tr>
                      <th className="px-3 py-2 font-normal">Name</th>
                      <th className="px-3 py-2 font-normal">Role</th>
                      {board.days.map((d) => <th key={d.day} className="whitespace-nowrap px-2 py-2 font-normal">{d.label}</th>)}
                      <th className="px-3 py-2 font-normal">Missed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.people.map((p) => (
                      <tr key={p.staff_id} className="border-b border-line last:border-0">
                        <td className="whitespace-nowrap px-3 py-1.5 font-medium">{p.name}</td>
                        <td className="whitespace-nowrap px-3 py-1.5">{ROLE_LABEL[p.role] ?? p.role}</td>
                        {p.cells.map((cell, i) => (
                          <td key={board.days[i].day} className="px-2 py-1.5">
                            {cell === null ? (
                              <span className="text-muted" title="Not a working day">—</span>
                            ) : cell.state === "filed" ? (
                              <Link
                                href={readHref(p.staff_id, board.days[i].day)}
                                title={cell.submitted ? `Submitted ${cell.submitted} (${me.timezone})` : undefined}
                                className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs underline ${CELL.filed.className}`}
                              >
                                {CELL.filed.text}
                              </Link>
                            ) : (
                              <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs ${CELL[cell.state].className}`}>{CELL[cell.state].text}</span>
                            )}
                          </td>
                        ))}
                        <td className={`px-3 py-1.5 tabular-nums ${p.missed > 0 ? "font-semibold text-bad" : "text-muted"}`}>{p.missed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
