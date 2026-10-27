"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

type Status = "needs_action" | "confirmed" | "rescheduled" | "cancelled" | "all";
const KEY = "genexa.confirmations.filters";

/**
 * Clinic (multi-select) and status filters. They live in the URL, so a refresh
 * or the automatic re-sync keeps them, and are remembered in this browser so the
 * desk opens the way it was left. The page refreshes itself every minute.
 */
export function DeskFilters({
  clinics, selected, status, statuses,
}: {
  clinics: { id: string; name: string }[]; selected: string[]; status: Status; statuses: { key: Status; label: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const go = (nextClinics: string[], nextStatus: Status) => {
    const q = new URLSearchParams();
    if (nextClinics.length) q.set("clinic", nextClinics.join(","));
    if (nextStatus !== "needs_action") q.set("status", nextStatus);
    try { localStorage.setItem(KEY, q.toString()); } catch { /* private window: the URL still holds it */ }
    router.replace(`${pathname}${q.toString() ? `?${q}` : ""}`, { scroll: false });
  };

  // Open the way it was left in this browser, when the URL says nothing.
  useEffect(() => {
    if (params.toString()) return;
    try {
      const saved = localStorage.getItem(KEY);
      if (saved) router.replace(`${pathname}?${saved}`, { scroll: false });
    } catch { /* nothing saved */ }
  }, [params, pathname, router]);

  // Fresh numbers every minute (the sync runs every 5), filters untouched.
  useEffect(() => {
    const t = setInterval(() => router.refresh(), 60_000);
    return () => clearInterval(t);
  }, [router]);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const label = selected.length === 0 ? "All clinics"
    : selected.length === 1 ? clinics.find((c) => c.id === selected[0])?.name ?? "1 clinic" : `${selected.length} clinics`;
  const toggle = (id: string) => go(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id], status);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div ref={box} className="relative">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
          className="flex min-w-48 cursor-pointer items-center justify-between gap-2 rounded-md border border-line bg-panel px-3 py-1.5 text-sm">
          {label} <span className="text-muted">▾</span>
        </button>
        {open ? (
          <div className="absolute z-20 mt-1 max-h-80 w-72 overflow-y-auto rounded-md border border-line bg-panel p-1 shadow-lg">
            <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-raised">
              <input type="checkbox" checked={selected.length === 0} onChange={() => go([], status)} /> All clinics
            </label>
            {clinics.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-raised">
                <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} /> {c.name}
              </label>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex overflow-hidden rounded-md border border-line">
        {statuses.map((s) => (
          <button key={s.key} type="button" onClick={() => go(selected, s.key)}
            className={`cursor-pointer px-3 py-1.5 text-xs ${s.key === status ? "bg-accent font-medium text-white" : "bg-panel text-muted hover:text-ink"}`}>
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
