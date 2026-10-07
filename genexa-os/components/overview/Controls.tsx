"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { PERIODS, type PeriodKey } from "@/lib/periods";

export function PeriodControls({ active, basePath }: { active: PeriodKey; basePath: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex overflow-hidden rounded-md border border-line">
        {PERIODS.map((p) => (
          <Link
            key={p.key}
            href={`${basePath}?period=${p.key}`}
            className={`px-3 py-1.5 text-xs ${p.key === active ? "bg-accent font-medium text-white" : "bg-panel text-muted hover:text-ink"}`}
          >
            {p.label}
          </Link>
        ))}
      </div>
      <button
        type="button"
        onClick={() => start(() => router.refresh())}
        className="cursor-pointer rounded-md border border-line bg-panel px-3 py-1.5 text-xs text-muted hover:text-ink"
      >
        {pending ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}
