"use client";

import { useActionState } from "react";
import { clockIn, clockOut, type ClockState } from "@/lib/actions/attendance";
import type { MyAttendance } from "@/lib/queries/attendance";

const STATUS: Record<string, { label: string; className: string }> = {
  on_time: { label: "on time", className: "bg-good-bg text-good" },
  late: { label: "late", className: "bg-warn-bg text-warn" },
  no_show: { label: "no-show", className: "bg-bad-bg text-bad" },
  excused: { label: "excused", className: "bg-stale-bg text-muted" },
};
const START: ClockState = { error: null };

/** Display only: every label and time arrives ready-made from my_attendance(). */
export function ClockControl({ mine }: { mine: MyAttendance }) {
  const [inState, inAction, inPending] = useActionState(clockIn, START);
  const [outState, outAction, outPending] = useActionState(clockOut, START);
  const error = inState.error ?? outState.error;
  const status = mine.status ? STATUS[mine.status] : undefined;
  const shift = mine.shift_label ? `Shift ${mine.shift_label}` : mine.excused ? "Excused today" : "Not rostered today";
  const button = "cursor-pointer rounded bg-accent px-2.5 py-1 font-medium text-white disabled:cursor-default disabled:opacity-60";

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-panel px-4 py-2 text-xs" title={`Times in ${mine.timezone}`}>
      {mine.state === "not_clocked_in" ? (
        <>
          <span>
            <span className="font-medium text-ink">{shift}</span> <span className="text-muted">· not clocked in</span>
          </span>
          <form action={inAction}>
            <button type="submit" disabled={inPending} className={button}>{inPending ? "Clocking in…" : "Clock in"}</button>
          </form>
        </>
      ) : mine.state === "clocked_in" ? (
        <>
          <span className="font-medium text-ink">Clocked in {mine.clock_in_label}</span>
          {mine.shift_label ? <span className="text-muted">· {shift}</span> : null}
          <form action={outAction}>
            <button type="submit" disabled={outPending} className={button}>{outPending ? "Clocking out…" : "Clock out"}</button>
          </form>
        </>
      ) : (
        <>
          <span className="font-medium text-ink">Clocked out {mine.clock_out_label}</span>
          <span className="text-muted">
            · in {mine.clock_in_label}
            {mine.shift_label ? ` · ${shift}` : ""}
          </span>
        </>
      )}
      {status ? (
        <span className={`rounded px-1.5 py-0.5 ${status.className}`}>
          {status.label}
          {mine.status !== "on_time" && mine.minutes_late ? ` · ${mine.minutes_late} min` : ""}
        </span>
      ) : null}
      {error ? <span role="alert" className="rounded bg-bad-bg px-2 py-0.5 text-bad">{error}</span> : null}
    </div>
  );
}
