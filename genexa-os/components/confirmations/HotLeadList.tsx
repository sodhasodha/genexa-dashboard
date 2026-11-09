"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { openLead } from "@/lib/actions/hotLeads";
import type { HotLeadRow } from "@/lib/queries/hotLeads";
import type { HotReason } from "@/lib/hotLeads/rules";

const BADGE: Record<HotReason, string> = {
  reschedule: "bg-bad-bg text-bad",
  callback: "bg-warn-bg text-warn",
  mid_conversation: "bg-good-bg text-good",
};
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/**
 * The list: name, clinic, reason. Clicking a row opens the contact in GHL in a new
 * tab and greys it out for everyone for 15 minutes. Refreshes every 2 minutes and
 * when the tab is looked at again.
 */
export function HotLeadList({ rows }: { rows: HotLeadRow[] }) {
  const router = useRouter();
  const [mine, setMine] = useState<Set<string>>(new Set());

  useEffect(() => {
    const t = setInterval(() => router.refresh(), 120_000);
    const back = () => { if (document.visibilityState === "visible") router.refresh(); };
    document.addEventListener("visibilitychange", back);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", back); };
  }, [router]);

  if (!rows.length) return <p className="rounded-lg border border-line bg-panel px-4 py-8 text-center text-sm text-muted">No hot leads right now.</p>;

  return (
    <ul className="overflow-hidden rounded-lg border border-line bg-panel">
      {rows.map((r) => {
        const grey = !!r.claimed || mine.has(r.id);
        const content = (
          <>
            <span className="min-w-0 flex-1 truncate font-medium">{r.patient_name}</span>
            <span className="w-48 shrink-0 truncate text-sm text-muted">{r.clinic}</span>
            <span className={`w-40 shrink-0 rounded px-1.5 py-0.5 text-center text-xs font-medium ${BADGE[r.reason]}`}>{r.label}</span>
          </>
        );
        return (
          <li key={r.id} data-lead={r.id} data-claimed={grey ? "1" : undefined} className={`border-b border-line last:border-0 ${grey ? "opacity-45" : ""}`}
            title={r.claimed ? `Opened by ${r.claimed.by} at ${time(r.claimed.at)}` : undefined}>
            {r.ghl_url ? (
              <a href={r.ghl_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 px-4 py-2.5 hover:bg-raised"
                onClick={() => { setMine((s) => new Set(s).add(r.id)); void openLead(r.id); }}>
                {content}
              </a>
            ) : <div className="flex items-center gap-3 px-4 py-2.5">{content}</div>}
          </li>
        );
      })}
    </ul>
  );
}
