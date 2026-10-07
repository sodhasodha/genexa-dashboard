import { saveActionTaken } from "@/lib/actions/media";
import type { AdException } from "@/lib/queries/media";
import { th } from "./Cells";

/** Open ad exceptions, oldest first. The owner of each one (or the app owner) records what was done. */
export function AdExceptions({ exceptions, meId, isOwner, slaNote }: { exceptions: AdException[]; meId: string; isOwner: boolean; slaNote: string | null }) {
  return (
    <section className="rounded-lg border border-line bg-panel">
      <h2 className="flex items-center gap-2 px-4 py-3 text-sm font-semibold">
        Open ad exceptions
        <span className={`rounded-full px-2 py-0.5 text-xs ${exceptions.length > 0 ? "bg-bad-bg text-bad" : "bg-good-bg text-good"}`}>{exceptions.length}</span>
        <span className="ml-auto text-xs font-normal text-muted" title={slaNote ?? undefined}>oldest first</span>
      </h2>
      {exceptions.length === 0 ? (
        <p className="border-t border-line px-4 py-6 text-sm text-muted">No open ad exceptions.</p>
      ) : (
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className={th}>What</th>
                <th className={th}>Type</th>
                <th className={th}>Owner</th>
                <th className={th}>Open for</th>
                <th className={th}>Action taken</th>
              </tr>
            </thead>
            <tbody>
              {exceptions.map((e) => (
                <tr key={e.id} id={`exception-${e.id}`} className="border-t border-line align-top">
                  <td className="px-3 py-2">
                    <span className={`mr-2 inline-block size-2 rounded-full ${e.severity === "red" ? "bg-bad" : "bg-warn"}`} />
                    {e.reason}
                    {e.status === "snoozed" ? <span className="ml-2 rounded bg-stale-bg px-1.5 py-0.5 text-xs text-stale">snoozed</span> : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted">{e.type_label}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted">{e.owner_name ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted" title={`First detected ${e.detected} ET`}>{e.age}</td>
                  <td className="px-3 py-2">
                    {isOwner || e.owner_id === meId ? (
                      <form action={saveActionTaken} className="flex gap-1">
                        <input type="hidden" name="id" value={e.id} />
                        <input
                          name="action_taken" defaultValue={e.action_taken ?? ""} maxLength={2000} placeholder="What was done"
                          aria-label={`Action taken: ${e.reason}`} className="w-64 rounded border border-line px-1.5 py-1 text-xs"
                        />
                        <button className="cursor-pointer rounded border border-line bg-raised px-2 py-1 text-xs hover:border-muted">Save</button>
                      </form>
                    ) : (
                      <span className="text-xs text-muted">{e.action_taken ?? "none recorded"}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
