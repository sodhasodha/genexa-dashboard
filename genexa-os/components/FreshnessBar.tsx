import type { Freshness, SourceFreshness } from "@/lib/queries/freshness";

const DOT: Record<Freshness, string> = {
  fresh: "bg-good",
  late: "bg-warn",
  stale: "bg-bad",
  never: "bg-stale",
};

export function FreshnessBar({ sources }: { sources: SourceFreshness[] }) {
  return (
    // Phone: one line that scrolls sideways, so it doesn't push the page down.
    <div className="flex gap-x-5 gap-y-1 border-b border-line bg-panel px-4 py-2 text-xs text-muted max-md:overflow-x-auto max-md:whitespace-nowrap md:flex-wrap">
      {sources.map((s) => (
        <span key={s.source} className="flex shrink-0 items-center gap-1.5" title={s.error ?? undefined}>
          <span className={`inline-block size-2 rounded-full ${DOT[s.freshness]}`} />
          <span className="font-medium text-ink">{s.source}</span>
          <span>{s.label}</span>
        </span>
      ))}
    </div>
  );
}
