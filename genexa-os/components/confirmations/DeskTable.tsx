"use client";

import { useState, useTransition } from "react";
import { logCall } from "@/lib/actions/confirmations";
import type { DeskRow, Outcome } from "@/lib/queries/confirmations";

const MAX = 10;
const OUTCOMES: { key: Outcome; label: string }[] = [
  { key: "confirmed", label: "Confirmed" }, { key: "no_answer", label: "No answer" },
  { key: "voicemail", label: "Voicemail left" }, { key: "rescheduled", label: "Rescheduled" },
];
const STATUS: Record<string, string> = {
  unconfirmed: "Unconfirmed", confirmed: "Confirmed", rescheduled: "Rescheduled", cancelled: "Cancelled", unreachable: "Unreachable", expired: "Expired - unconfirmed",
};
const ROW: Record<string, string> = { red: "bg-bad-bg", amber: "bg-warn-bg", green: "bg-good-bg", grey: "opacity-60", none: "" };
const PILL: Record<string, string> = { red: "text-bad", amber: "text-warn", green: "text-good", grey: "text-muted", none: "text-ink" };
/** What to do in GoHighLevel after logging, since Genexa OS does not change GHL. */
const GHL_STEP: Partial<Record<Outcome, string>> = {
  confirmed: "Now move this appointment to the clinic's Confirmed calendar in GoHighLevel. Genexa OS does not change GoHighLevel: until it is moved, the clinic's main calendar will not show the patient.",
  rescheduled: "Now change this appointment in GoHighLevel to the new date and time the patient agreed.",
};

export function DeskTable({ rows }: { rows: DeskRow[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const open = rows.find((r) => r.id === openId) ?? null;

  const log = (row: DeskRow, outcome: Outcome) => {
    setError(null);
    start(async () => {
      const r = await logCall({ appointment_id: row.id, outcome });
      if (!r.ok) { setError(r.message); return; }
      setOpenId(null);
      const step = GHL_STEP[outcome];
      if (step) setNotice({ title: outcome === "confirmed" ? "Confirmed: now update GoHighLevel" : "Rescheduled: now update GoHighLevel", body: `${row.patient_name ?? "Patient"} · ${row.clinic}. ${step}` });
      else if (r.status === "unreachable") setNotice({ title: "Unreachable", body: `That was call ${MAX} of ${MAX} for ${row.patient_name ?? "this patient"}. No more calls can be logged.` });
    });
  };

  if (rows.length === 0) return <p className="rounded-lg border border-line bg-panel px-4 py-8 text-center text-sm text-muted">Nothing here right now.</p>;

  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-line bg-panel">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-normal">Patient</th>
              <th className="px-3 py-2 font-normal">Phone</th>
              <th className="px-3 py-2 font-normal">Clinic</th>
              <th className="px-3 py-2 font-normal">Appointment (clinic time)</th>
              <th className="px-3 py-2 font-normal">Philippines time</th>
              <th className="px-3 py-2 font-normal">Time left</th>
              <th className="px-3 py-2 font-normal">Status</th>
              <th className="px-3 py-2 text-right font-normal">Calls</th>
              <th className="px-3 py-2 font-normal">Last attempt</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => { setError(null); setOpenId(r.id); }}
                className={`cursor-pointer border-b border-line align-top last:border-0 hover:brightness-110 ${ROW[r.urgency] ?? ""}`}>
                <td className="whitespace-nowrap px-3 py-2 font-medium">{r.patient_name ?? "Unknown patient"}</td>
                <td className="whitespace-nowrap px-3 py-2">
                  {r.tel ? <a href={r.tel} onClick={(e) => e.stopPropagation()} className="text-accent underline underline-offset-2">{r.phone}</a> : <span className="text-muted">{r.phone ?? "no phone"}</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2">{r.clinic}{r.location_label ? <span className="text-muted"> · {r.location_label}</span> : null}</td>
                <td className="whitespace-nowrap px-3 py-2">{r.clinic_time}</td>
                <td className="whitespace-nowrap px-3 py-2 text-muted">{r.ph_time}</td>
                <td className={`whitespace-nowrap px-3 py-2 font-semibold tabular-nums ${PILL[r.urgency] ?? ""}`}>{r.time_left}</td>
                <td className="whitespace-nowrap px-3 py-2">
                  {STATUS[r.status] ?? r.status}
                  {r.status === "confirmed" && !r.on_main_calendar ? <span className="block text-xs text-warn">not moved in GHL yet</span> : null}
                  {r.booked_on === "main" ? <span className="block text-xs text-muted">booked on Confirmed calendar</span> : null}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{r.attempts}/{MAX}</td>
                <td className="px-3 py-2 text-xs text-muted">{r.last_text ?? "No calls yet"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open ? (
        <div role="dialog" aria-modal="true" aria-label="Log a call" className="fixed inset-0 z-30 flex items-end justify-center bg-black/50 p-4 sm:items-center" onClick={() => setOpenId(null)}>
          <div className="w-full max-w-md rounded-lg border border-line bg-panel p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold">{open.patient_name ?? "Unknown patient"}</p>
                <p className="text-xs text-muted">{open.clinic}{open.location_label ? ` · ${open.location_label}` : ""} · {open.clinic_time} · {open.ph_time}</p>
              </div>
              <button type="button" onClick={() => setOpenId(null)} className="cursor-pointer text-muted hover:text-ink" aria-label="Close">✕</button>
            </div>
            {open.tel ? <a href={open.tel} className="mt-3 inline-block rounded bg-accent px-3 py-1.5 text-sm font-medium text-white">Call {open.phone}</a> : <p className="mt-3 text-sm text-muted">No phone number on this patient.</p>}
            {open.status === "unconfirmed" && open.attempts < MAX ? (
              <div className="mt-4">
                <p className="text-sm font-medium">Log call {open.attempts + 1} of {MAX}</p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {OUTCOMES.map((o) => (
                    <button key={o.key} type="button" disabled={pending} onClick={() => log(open, o.key)}
                      className="cursor-pointer rounded border border-line bg-raised px-3 py-2 text-sm hover:border-muted disabled:cursor-wait disabled:opacity-50">
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="mt-4 rounded bg-raised px-3 py-2 text-sm text-muted">
                {open.attempts >= MAX || open.status === "unreachable" ? `Unreachable: all ${MAX} calls have been made.` : `${STATUS[open.status] ?? open.status}: no more calls to log.`}
              </p>
            )}
            {error ? <p className="mt-3 rounded bg-bad-bg px-3 py-2 text-sm text-bad">{error}</p> : null}
            <p className="mt-3 text-xs text-muted">{open.attempts} of {MAX} calls made{open.last_text ? ` · last: ${open.last_text}` : ""}</p>
          </div>
        </div>
      ) : null}

      {notice ? (
        <div role="alertdialog" aria-modal="true" aria-label={notice.title} className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg border border-warn bg-panel p-5">
            <p className="font-semibold text-warn">{notice.title}</p>
            <p className="mt-2 text-sm">{notice.body}</p>
            <button type="button" onClick={() => setNotice(null)} className="mt-4 cursor-pointer rounded bg-accent px-4 py-2 text-sm font-medium text-white">OK, done in GoHighLevel</button>
          </div>
        </div>
      ) : null}
    </>
  );
}
