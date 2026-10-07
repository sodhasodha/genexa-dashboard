import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireEnv } from "@/lib/env";
import { createCortanaClient } from "@/lib/integrations/cortana/client";
import { syncCortana, syncCortanaEvents } from "@/lib/integrations/cortana/sync";
import { createWhopClient } from "@/lib/integrations/whop/client";
import { syncGhlAppointments, type GhlKeys } from "@/lib/integrations/ghl/sync";
import { syncMercury } from "@/lib/integrations/mercury/sync";
import { JOBS_PAYROLL } from "@/lib/jobs/payroll";
import { JOBS_ATTENDANCE } from "@/lib/jobs/attendance";
import { JOBS_REMINDERS } from "@/lib/jobs/reminders";
import { JOBS_MISC } from "@/lib/jobs/misc";
import { JOBS_NUDGES } from "@/lib/jobs/nudges";
import { syncFathom } from "@/lib/integrations/fathom/sync";
import { syncWhop } from "@/lib/integrations/whop/sync";
import { addDays, etToday } from "@/lib/time";
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
  // Funnel and outcome events. Re-reads 14 days each time: clinics log shows and sales late.
  "cortana-events": async () => {
    const r = await syncCortanaEvents({ db: createAdminClient(), cortana: cortana(), from: addDays(etToday(), -14) });
    return { ok: r.ok, summary: r };
  },
  // Genexa's own payments and memberships, direct from Whop.
  "whop-sync": async () => {
    const r = await syncWhop({ db: createAdminClient(), whop: createWhopClient({ apiKey: requireEnv("WHOP_API_KEY") }), since: "2026-08-01" });
    return { ok: r.ok, summary: { ...r, unmatched: r.unmatched.length } };
  },
  // GHL consult calendars -> appointments, then outcomes copied across from Cortana.
  "ghl-appointments": async () => {
    const r = await syncGhlAppointments({ db: createAdminClient(), keys: JSON.parse(requireEnv("GHL_API_KEYS_JSON")) as GhlKeys });
    return { ok: r.ok, summary: r };
  },
  // Bank transactions (through the static-IP proxy), then the finance rules.
  "mercury-sync": async () => {
    const r = await syncMercury({ db: createAdminClient(), apiKey: requireEnv("MERCURY_API_KEY"), proxyUrl: process.env.FIXIE_URL, since: "2026-08-01" });
    return { ok: r.ok, summary: r };
  },
  ...JOBS_PAYROLL,
  ...JOBS_ATTENDANCE,
  ...JOBS_REMINDERS,
  ...JOBS_MISC,
  ...JOBS_NUDGES,
  // Client and sales calls: touches, last contact, prospect call dates.
  "fathom-sync": async () => {
    const r = await syncFathom({ db: createAdminClient(), apiKey: requireEnv("FATHOM_API_KEY"), since: "2026-08-01" });
    return { ok: r.ok, summary: r };
  },
  exceptions: async () => {
    const r = await runExceptionsEngine(createAdminClient());
    return { ok: true, summary: r };
  },
};
