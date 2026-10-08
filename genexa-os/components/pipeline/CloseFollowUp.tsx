import { followUpLater, notFollowingUp } from "@/lib/actions/pipeline";
import { NOT_FOLLOWING_UP_REASONS } from "@/lib/pipeline/reasons";

const field = "rounded border border-line px-1.5 py-1 text-xs";
const quiet = "cursor-pointer rounded border border-line px-2 py-1 text-xs";

/**
 * The two ways to close a follow-up without doing it (owner only; the caller decides who sees it).
 * "Not following up" moves the prospect to Dead with a reason; "Follow up later" sets a new date.
 * `earliest` is the first day the database accepts (tomorrow in ET). `from` says where to return to.
 */
export function CloseFollowUp({ id, name, earliest, from = "pipeline" }: { id: string; name: string; earliest: string; from?: "pipeline" | "prospect" }) {
  return (
    <div className="flex flex-col gap-1.5">
      <details>
        <summary className="cursor-pointer whitespace-nowrap text-xs text-muted">Not following up</summary>
        <form action={notFollowingUp} className="mt-1.5 flex w-52 flex-col gap-1.5">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="from" value={from} />
          <select name="reason" required defaultValue="" aria-label={`Why ${name} is not being followed up`} className={field}>
            <option value="" disabled>Reason</option>
            {NOT_FOLLOWING_UP_REASONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
          <input name="reason_text" maxLength={1000} placeholder="Details (needed for Other)" aria-label={`Details for ${name}`} className={field} />
          <div>
            <button type="submit" className={quiet}>Move to Dead</button>
          </div>
        </form>
      </details>
      <details>
        <summary className="cursor-pointer whitespace-nowrap text-xs text-muted">Follow up later</summary>
        <form action={followUpLater} className="mt-1.5 flex items-center gap-1">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="from" value={from} />
          <input type="date" name="follow_up_date" required min={earliest} aria-label={`New follow-up date for ${name}`} className={field} />
          <button type="submit" className={quiet}>Set</button>
        </form>
      </details>
    </div>
  );
}
