import Link from "next/link";
import { moveLaunch, pauseLaunch, resumeLaunch, saveQc, setBrokeWeek1, startLaunch } from "@/lib/actions/launches";
import { requireStaff } from "@/lib/auth/staff";
import { QC_FIELDS, getLaunchBoard, type LaunchCard, type LaunchStage, type QcField } from "@/lib/queries/launches";

const STAGE_LABEL: Record<LaunchStage, string> = {
  paid: "Paid", ob_call_booked: "Onboarding call booked", ob_call_done: "Onboarding call done", ob_form_complete: "OB form complete",
  access_granted: "Access granted", built: "Built", qc_passed: "QC passed", live: "Live",
};
const QC_LABEL: Record<QcField, string> = {
  qc_lead_access: "Lead access", qc_calendar_tested: "Calendar tested", qc_test_lead_deleted: "Test lead deleted",
  qc_pixel_firing: "Pixel firing", qc_cortana_connected: "Cortana connected", qc_clinic_sheet: "Clinic sheet",
};
const PAUSE_REASON: Record<string, string> = {
  client_access: "Waiting on client access", client_approval: "Waiting on client approval",
  client_assets: "Waiting on client assets", third_party: "Waiting on a third party",
};
const ERRORS: Record<string, string> = {
  qc: "LAUNCH_QC: all six QC checks must be ticked before QC passed / Live. Nothing was changed.",
  back: "Only the owner can move a launch back a stage.",
  refused: "Not saved: only the launch's owner or the app owner can change a launch.",
  owner_only: "Only the owner can start a launch.",
  moved: "That card had already moved. The board below is current; try again.",
  gone: "That launch is no longer on the board.",
  pause_invalid: "Not paused: pick a reason and write the evidence (what was asked for, where, when).",
  already_paused: "That launch is already paused.",
  start_invalid: "Not started: pick a client and a paid date.",
  start_future: "Not started: the paid date cannot be in the future.",
  start_open: "Not started: that client already has an open launch.",
  save: "Not saved: the database refused the change.",
};
const SAVED: Record<string, string> = {
  moved: "Launch moved.", qc: "QC checks saved.", flag: "Flag saved.", paused: "SLA clock paused.", resumed: "SLA clock resumed.", started: "Launch started.",
};
const WAIT_TONE: Record<string, string> = { green: "text-muted", amber: "text-warn", red: "text-bad" };
const input = "rounded border border-line bg-raised px-2 py-1 text-xs";
const button = "cursor-pointer rounded bg-accent px-2 py-1 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40";
const quiet = "cursor-pointer rounded border border-line px-2 py-1 text-xs text-muted hover:text-ink";

function Sla({ card }: { card: LaunchCard }) {
  if (!card.clock_started) {
    const waitingOn = [!card.ob_form_done ? "OB form" : null, !card.access_done ? "access" : null].filter(Boolean).join(" and ");
    return <p className="text-xs text-muted">SLA: clock not started{waitingOn ? ` (needs ${waitingOn})` : ""}</p>;
  }
  const tone = card.is_overdue ? "text-bad font-semibold" : card.is_paused ? "text-warn" : "text-ink";
  return (
    <p className={`text-xs ${tone}`}>
      SLA: {card.sla_hours_elapsed ?? "no data"}h of {card.sla_hours_allowed ?? "no data"}h
      {card.is_overdue ? " · overdue" : ""}
      {card.stage === "live" && card.met_sla ? " · met" : ""}
      {card.is_paused ? " · paused" : ""}
    </p>
  );
}

function Card({ card }: { card: LaunchCard }) {
  const next = card.next_stage;
  const needsQc = next === "qc_passed" || next === "live";
  const blocked = needsQc && !card.qc_all;
  return (
    <div className="flex flex-col gap-2 rounded border border-line bg-raised p-2.5 text-sm">
      <div>
        <Link href={`/clients/${card.client_id}`} className="font-medium underline decoration-line underline-offset-2 hover:decoration-ink">{card.client_name}</Link>
        <p className="text-xs text-muted">Owner: {card.owner_name ?? "nobody"}</p>
      </div>

      {card.stage === "live" ? (
        <p className="text-xs text-muted">
          Live {card.live_on}{card.days_paid_to_live !== null ? ` · ${card.days_paid_to_live} days from payment` : ""}
        </p>
      ) : card.days_waiting === null ? (
        <p className="text-xs text-stale">No payment date</p>
      ) : (
        <p className={`text-xs ${WAIT_TONE[card.waiting_colour ?? "green"]} ${card.waiting_colour === "red" ? "font-semibold" : ""}`}>
          {card.days_waiting} {card.days_waiting === 1 ? "day" : "days"} since payment
        </p>
      )}
      <Sla card={card} />
      {card.is_paused ? (
        <p className="rounded bg-warn-bg px-2 py-1 text-xs text-warn">
          Paused {card.paused_on}: {PAUSE_REASON[card.pause_reason ?? ""] ?? card.pause_reason}. {card.pause_note}
        </p>
      ) : null}
      {card.broke_week1 ? <p className="rounded bg-bad-bg px-2 py-1 text-xs text-bad">Broke in week 1</p> : null}

      <form action={saveQc} className="flex flex-col gap-1 border-t border-line pt-2">
        <input type="hidden" name="launch_id" value={card.launch_id} />
        <p className="text-xs text-muted">QC {card.qc_done} of 6</p>
        {QC_FIELDS.map((f) => (
          <label key={f} className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" name={f} defaultChecked={card.qc[f]} disabled={!card.can_act} />
            {QC_LABEL[f]}
          </label>
        ))}
        {card.can_act ? <div><button type="submit" className={quiet}>Save QC</button></div> : null}
      </form>

      {card.can_act ? (
        <div className="flex flex-col gap-2 border-t border-line pt-2">
          {next ? (
            <form action={moveLaunch}>
              <input type="hidden" name="launch_id" value={card.launch_id} />
              <input type="hidden" name="direction" value="forward" />
              <input type="hidden" name="to" value={next} />
              <button type="submit" disabled={blocked} title={blocked ? "Tick and save all six QC checks first" : undefined} className={button}>
                Move to {STAGE_LABEL[next]}
              </button>
              {blocked ? <p className="mt-1 text-xs text-muted">Needs all six QC checks.</p> : null}
            </form>
          ) : null}
          {card.can_move_back && card.prev_stage ? (
            <form action={moveLaunch}>
              <input type="hidden" name="launch_id" value={card.launch_id} />
              <input type="hidden" name="direction" value="back" />
              <input type="hidden" name="to" value={card.prev_stage} />
              <button type="submit" className={quiet}>Back to {STAGE_LABEL[card.prev_stage]}</button>
            </form>
          ) : null}

          {card.stage === "live" ? (
            <form action={setBrokeWeek1}>
              <input type="hidden" name="launch_id" value={card.launch_id} />
              <input type="hidden" name="broke" value={card.broke_week1 ? "false" : "true"} />
              <button type="submit" className={quiet}>{card.broke_week1 ? "Clear broke in week 1" : "Flag broke in week 1"}</button>
            </form>
          ) : card.is_paused ? (
            <form action={resumeLaunch}>
              <input type="hidden" name="launch_id" value={card.launch_id} />
              <button type="submit" className={quiet}>Resume SLA clock</button>
            </form>
          ) : (
            <details>
              <summary className="cursor-pointer text-xs text-muted">Pause SLA clock</summary>
              <form action={pauseLaunch} className="mt-1.5 flex flex-col gap-1.5">
                <input type="hidden" name="launch_id" value={card.launch_id} />
                <select name="reason" required defaultValue="" aria-label="Pause reason" className={input}>
                  <option value="" disabled>Reason</option>
                  {Object.entries(PAUSE_REASON).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <textarea name="evidence_note" required rows={2} placeholder="Evidence: what was asked for, where, when" aria-label="Evidence note" className={input} />
                <div><button type="submit" className={quiet}>Pause</button></div>
              </form>
            </details>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default async function LaunchesPage({ searchParams }: PageProps<"/launches">) {
  const me = await requireStaff();
  const params = await searchParams;
  const board = await getLaunchBoard(me);
  const isOwner = me.role === "owner";
  const error = typeof params.error === "string" ? ERRORS[params.error] : undefined;
  const saved = typeof params.saved === "string" ? SAVED[params.saved] : undefined;
  const total = board.columns.reduce((a, c) => a + c.cards.length, 0);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h1 className="text-lg font-semibold">Launches</h1>
        <p className="text-xs text-muted">
          A card sits in the furthest stage that has been timestamped. The SLA clock starts when the OB form and access are both done.
          {board.liveDays !== null ? ` Live launches leave the board after ${board.liveDays} days.` : ""} {isOwner ? "" : "You can act on launches you own; everything else is read-only."}
        </p>
        {error ? <p className="mt-2 rounded bg-bad-bg px-3 py-2 text-sm text-bad">{error}</p> : null}
        {saved ? <p className="mt-2 rounded bg-good-bg px-3 py-2 text-sm text-good">{saved}</p> : null}
      </div>

      {isOwner ? (
        <details className="rounded border border-line bg-panel">
          <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">Start a launch</summary>
          {board.candidates.length === 0 ? (
            <p className="border-t border-line p-3 text-sm text-muted">Every client already has an open launch.</p>
          ) : (
            <form action={startLaunch} className="flex flex-wrap items-end gap-3 border-t border-line p-3">
              <label className="flex flex-col gap-1 text-xs text-muted">Client
                <select name="client_id" required defaultValue="" className={input}>
                  <option value="" disabled>Pick a client with no open launch</option>
                  {board.candidates.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.stage})</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted">Paid date (ET)
                <input type="date" name="paid_date" required defaultValue={board.today} max={board.today} className={input} />
              </label>
              <button type="submit" className={button}>Start launch</button>
              <span className="text-xs text-muted">The tech role holder is set as the launch owner.</span>
            </form>
          )}
        </details>
      ) : null}

      {total === 0 ? <p className="rounded border border-line bg-panel px-4 py-6 text-sm text-muted">No launches on the board.</p> : null}

      <div className="flex gap-3 overflow-x-auto pb-2">
        {board.columns.map((col) => (
          <section key={col.stage} className="flex w-60 shrink-0 flex-col gap-2 rounded border border-line bg-panel p-2">
            <h2 className="flex items-center justify-between text-xs font-semibold">
              {STAGE_LABEL[col.stage]}
              <span className="font-normal text-muted">{col.cards.length}</span>
            </h2>
            {col.cards.map((card) => <Card key={card.launch_id} card={card} />)}
          </section>
        ))}
      </div>
    </div>
  );
}
