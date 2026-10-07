import { addIdea, deleteIdea } from "@/lib/actions/ideas";
import { requireStaff } from "@/lib/auth/staff";
import { getIdeas } from "@/lib/queries/ideas";

const ERRORS: Record<string, string> = {
  invalid: "Write the idea before adding it.",
  save: "The idea could not be saved.",
};
const SAVED: Record<string, string> = { added: "Idea added.", deleted: "Idea removed." };

export default async function IdeasPage({ searchParams }: PageProps<"/ideas">) {
  const me = await requireStaff();
  const params = await searchParams;
  const ideas = await getIdeas();
  const isOwner = me.role === "owner";
  const error = typeof params.error === "string" ? ERRORS[params.error] : undefined;
  const saved = typeof params.saved === "string" ? SAVED[params.saved] : undefined;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h1 className="text-lg font-semibold">Ideas</h1>
        {error ? <p className="mt-2 rounded bg-bad-bg px-3 py-2 text-bad">{error}</p> : null}
        {saved ? <p className="mt-2 rounded bg-good-bg px-3 py-2 text-good">{saved}</p> : null}
      </div>

      <form action={addIdea} className="flex flex-col gap-2 rounded border border-line bg-panel p-3 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-xs text-muted">
          Idea
          <textarea name="text" required rows={2} maxLength={4000} className="rounded border border-line px-2 py-1 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted sm:w-56">
          Source (optional)
          <input name="source" maxLength={200} className="rounded border border-line px-2 py-1 text-sm" />
        </label>
        <button type="submit" className="cursor-pointer self-start rounded bg-accent px-3 py-1.5 text-xs font-medium text-white sm:self-auto">
          Add idea
        </button>
      </form>

      {ideas.length === 0 ? (
        <p className="rounded border border-line bg-panel px-4 py-6 text-sm text-muted">No ideas yet.</p>
      ) : (
        <div className="overflow-x-auto rounded border border-line bg-panel">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-normal">Idea</th>
                <th className="px-3 py-2 font-normal">Source</th>
                <th className="px-3 py-2 font-normal">Added</th>
                {isOwner ? <th className="px-3 py-2 font-normal" /> : null}
              </tr>
            </thead>
            <tbody>
              {ideas.map((i) => (
                <tr key={i.id} className="border-b border-line align-top last:border-0">
                  <td className="whitespace-pre-wrap px-3 py-2">{i.text}</td>
                  <td className="px-3 py-2">{i.source ?? <span className="text-stale">no data</span>}</td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">{i.day_label ?? <span className="text-stale">no data</span>}</td>
                  {isOwner ? (
                    <td className="px-3 py-2 text-right">
                      <form action={deleteIdea}>
                        <input type="hidden" name="id" value={i.id} />
                        <button type="submit" className="cursor-pointer rounded bg-bad-bg px-2 py-1 text-xs font-medium text-bad">Remove</button>
                      </form>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
