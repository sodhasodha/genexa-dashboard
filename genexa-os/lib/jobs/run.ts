import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireEnv } from "@/lib/env";
import { createCortanaClient } from "@/lib/integrations/cortana/client";
import { syncCortana } from "@/lib/integrations/cortana/sync";
import { runExceptionsEngine } from "@/lib/exceptions/engine";

export type JobResult = { ok: boolean; summary: Record<string, unknown> };

const cortana = () => createCortanaClient({ apiKey: requireEnv("CORTANA_API_KEY"), baseUrl: process.env.CORTANA_BASE_URL });

/** Every scheduled job, by the name pg_cron calls it with. */
export const JOBS: Record<string, () => Promise<JobResult>> = {
  // Hourly: today and yesterday, plus the per-ad 7d / all-time windows.
  "cortana-sync": async () => {
    const r = await syncCortana({ db: createAdminClient(), cortana: cortana(), days: 2 });
    return { ok: r.ok, summary: r };
  },
  // 02:30 ET: re-read the last 4 days, so late attribution and Meta corrections land.
  // Sized to finish inside the 300s function limit (about 1.9s per Cortana call, 96 calls);
  // the hourly job already refreshes the per-ad windows.
  "cortana-full": async () => {
    const r = await syncCortana({ db: createAdminClient(), cortana: cortana(), days: 4, windows: false });
    return { ok: r.ok, summary: r };
  },
  exceptions: async () => {
    const r = await runExceptionsEngine(createAdminClient());
    return { ok: true, summary: r };
  },
};
