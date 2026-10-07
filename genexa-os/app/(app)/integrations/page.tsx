import { DataTable } from "@/components/DataTable";
import { requireStaff } from "@/lib/auth/staff";
import { formatAge } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

const NAME: Record<string, string> = { cortana: "Cortana (ads, funnel, outcomes per clinic)", ghl: "GHL (appointments only: consult times and status)", hot_prospector: "Hot Prospector (calls) — not set up yet", whop: "Whop direct (payments, memberships, renewals)", mercury: "Mercury (expenses, profit)", fathom: "Fathom (client and sales calls)" };
const STATE: Record<string, string> = { fresh: "Fresh", late: "Late", stale: "Stale", never: "Not connected" };

export default async function IntegrationsPage() {
  const me = await requireStaff();
  const supabase = await createClient();
  const { data: sources, error } = await supabase.from("source_freshness").select("source, schedule_minutes, last_attempt_at, last_success_at, minutes_since_success, rows_processed, error, freshness").neq("source", "client_dashboard").order("source");
  if (error) throw new Error(error.message);
  const { data: runs } = me.role === "owner"
    ? await supabase.from("job_runs").select("job, started_at, finished_at, ok, rows_processed, error").order("started_at", { ascending: false }).limit(25)
    : { data: null };
  const at = (ts: string | null) => (ts ? new Date(ts).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) + " ET" : null);
  return (
    <div className="flex flex-col gap-5 p-4">
      <div>
        <h1 className="text-lg font-semibold">Integrations</h1>
        <p className="text-xs text-muted">A source is stale when its last successful sync is older than twice its schedule. Numbers from a stale source show grey, and alerts that depend on it stop.</p>
      </div>
      <DataTable
        columns={["Source", "Status", "Last success", "Last attempt", "Schedule", "Rows last run", "Error"]}
        rows={(sources ?? []).map((s) => [
          NAME[s.source] ?? s.source, STATE[s.freshness] ?? s.freshness,
          s.last_success_at ? `${formatAge(s.minutes_since_success)} · ${at(s.last_success_at)}` : "never",
          at(s.last_attempt_at) ?? "never", `every ${s.schedule_minutes >= 60 ? `${s.schedule_minutes / 60}h` : `${s.schedule_minutes} min`}`,
          s.rows_processed === null ? null : String(s.rows_processed), s.error ?? "—",
        ])}
      />
      {runs ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Recent job runs</h2>
          <DataTable
            columns={["Job", "Started", "Took", "Result", "Rows", "Error"]}
            rows={runs.map((r) => [
              r.job, at(r.started_at),
              r.finished_at ? `${Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000)}s` : "running",
              r.ok === null ? "—" : r.ok ? "ok" : "failed", r.rows_processed === null ? null : String(r.rows_processed), r.error ?? "—",
            ])}
          />
        </section>
      ) : null}
    </div>
  );
}
