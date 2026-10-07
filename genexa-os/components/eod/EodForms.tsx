import type { ReactNode } from "react";
import { CSR_BLOCKERS, MAX_TESTS, type CsrAnswers, type MediaBuyerAnswers, type TechAnswers } from "@/lib/eod/schema";

type Option = { id: string; label: string };

const INPUT = "rounded border border-line px-2 py-1.5";

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium">{label}</span>
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
      {children}
    </div>
  );
}

/** Tick list. Says so plainly when there is nothing to tick. */
function Checks({ name, options, selected, empty }: { name: string; options: Option[]; selected: string[]; empty: string }) {
  if (options.length === 0) return <p className="text-muted">{empty}</p>;
  return (
    <div className="flex flex-col gap-1">
      {options.map((o) => (
        <label key={o.id} className="flex items-start gap-2">
          <input type="checkbox" name={name} value={o.id} defaultChecked={selected.includes(o.id)} className="mt-0.5" />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

export function CsrFields({ saved, shiftHours }: { saved: CsrAnswers | null; shiftHours: number | null }) {
  return (
    <>
      <Field label="Hours worked today" hint={shiftHours !== null && !saved ? "Filled in from your shift. Change it if today was different." : undefined}>
        <input
          type="number" name="hours_worked" required min={0} max={24} step={0.25}
          defaultValue={saved?.hours_worked ?? shiftHours ?? ""} aria-label="Hours worked today" className={`${INPUT} w-28`}
        />
      </Field>
      <Field label="Biggest blocker today">
        <div className="flex flex-wrap gap-2">
          <select name="blocker" required defaultValue={saved?.blocker ?? ""} aria-label="Biggest blocker today" className={INPUT}>
            <option value="" disabled>Choose…</option>
            {CSR_BLOCKERS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
          <input
            name="blocker_other" maxLength={200} defaultValue={saved?.blocker_other ?? ""} placeholder="If Other: what was it?"
            aria-label="If Other, what was the blocker" className={`${INPUT} min-w-0 flex-1`}
          />
        </div>
      </Field>
      <Field label="Patient worth flagging (optional)" hint="First name only. No surname, phone number or medical detail.">
        <input name="patient_flag" maxLength={200} defaultValue={saved?.patient_flag ?? ""} aria-label="Patient worth flagging" className={INPUT} />
      </Field>
      <Field label="Focus today" hint="1 = distracted all day, 5 = locked in.">
        <div className="flex gap-4">
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} className="flex items-center gap-1">
              <input type="radio" name="focus" value={n} required defaultChecked={saved?.focus === n} />
              {n}
            </label>
          ))}
        </div>
      </Field>
    </>
  );
}

export function MediaBuyerFields({ saved, clients, exceptions }: { saved: MediaBuyerAnswers | null; clients: Option[]; exceptions: Option[] }) {
  const tests = saved?.tests ?? [];
  return (
    <>
      <Field label="Accounts touched today">
        <div className="sm:columns-2">
          <Checks name="accounts_touched" options={clients} selected={saved?.accounts_touched ?? []} empty="No live clients to list." />
        </div>
      </Field>
      <Field label="What changed" hint="Needed if you ticked any account.">
        <textarea name="what_changed" rows={3} maxLength={1000} defaultValue={saved?.what_changed ?? ""} aria-label="What changed" className={INPUT} />
      </Field>
      <Field label="Exceptions cleared today" hint="Your open ad exceptions, and any resolved today.">
        <Checks name="exceptions_cleared" options={exceptions} selected={saved?.exceptions_cleared ?? []} empty="You have no open ad exceptions." />
      </Field>
      <Field label="Tests launched (optional)" hint={`Up to ${MAX_TESTS}. A row counts only when a clinic is chosen.`}>
        {clients.length === 0 ? (
          <p className="text-muted">No live clients to list.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {Array.from({ length: MAX_TESTS }, (_, i) => (
              <div key={i} className="flex gap-2">
                <select name="test_client" defaultValue={tests[i]?.client_id ?? ""} aria-label={`Test ${i + 1} clinic`} className={`${INPUT} min-w-0 flex-1`}>
                  <option value="">No test</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
                <input
                  type="number" name="test_count" min={1} max={50} step={1} defaultValue={tests[i]?.count ?? 1}
                  aria-label={`Test ${i + 1} count`} className={`${INPUT} w-20`}
                />
              </div>
            ))}
          </div>
        )}
      </Field>
      <Field label="Creative needed (optional)" hint="Fill in all three, or leave all three blank.">
        <div className="flex flex-wrap gap-2">
          <input name="creative_needed" maxLength={200} defaultValue={saved?.creative_needed ?? ""} placeholder="What is needed" aria-label="Creative needed" className={`${INPUT} min-w-0 flex-1`} />
          <input name="creative_from" maxLength={200} defaultValue={saved?.creative_from ?? ""} placeholder="From whom" aria-label="Creative from whom" className={`${INPUT} w-40`} />
          <input type="date" name="creative_by" defaultValue={saved?.creative_by ?? ""} aria-label="Creative needed by" className={INPUT} />
        </div>
      </Field>
      <Field label="Note for the call centre (optional)">
        <textarea name="call_centre_note" rows={2} maxLength={1000} defaultValue={saved?.call_centre_note ?? ""} aria-label="Note for the call centre" className={INPUT} />
      </Field>
    </>
  );
}

export function TechFields({ saved, jobs }: { saved: TechAnswers | null; jobs: Option[] }) {
  return (
    <>
      <Field label="Jobs shipped today" hint="Your jobs that are open or were finished today.">
        <Checks name="jobs_shipped" options={jobs} selected={saved?.jobs_shipped ?? []} empty="You have no open jobs and none finished today." />
      </Field>
      <Field label="Blocked on what, or whom (optional)">
        <textarea name="blocked_on" rows={2} maxLength={1000} defaultValue={saved?.blocked_on ?? ""} aria-label="Blocked on what or whom" className={INPUT} />
      </Field>
      <Field label="Anything broken after going live (optional)">
        <textarea name="broke_after_live" rows={2} maxLength={1000} defaultValue={saved?.broke_after_live ?? ""} aria-label="Anything broken after going live" className={INPUT} />
      </Field>
      <Field label="First thing tomorrow">
        <input name="tomorrow_first" required maxLength={200} defaultValue={saved?.tomorrow_first ?? ""} aria-label="First thing tomorrow" className={INPUT} />
      </Field>
    </>
  );
}
