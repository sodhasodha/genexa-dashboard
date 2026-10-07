import "server-only";
import { createClient } from "@/lib/supabase/server";
import { formatAge } from "@/lib/format";

export type Freshness = "fresh" | "late" | "stale" | "never";

export type SourceFreshness = {
  source: string;
  freshness: Freshness;
  label: string;
  error: string | null;
};

const SOURCE_NAMES: Record<string, string> = {
  cortana: "Cortana",
  ghl: "GHL",
  whop: "Whop",
  mercury: "Mercury",
  fathom: "Fathom",
};

/** One entry per data source for the freshness bar, from the source_freshness view. */
export async function getSourceFreshness(): Promise<SourceFreshness[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("source_freshness")
    .select("source, freshness, minutes_since_success, error")
    // The client dashboard is no longer a source of its own: its outcomes reach the app through Cortana.
    .neq("source", "client_dashboard")
    .order("source");
  if (error) throw new Error(`source_freshness: ${error.message}`);
  return (data ?? []).map((row) => ({
    source: SOURCE_NAMES[row.source] ?? row.source,
    freshness: row.freshness as Freshness,
    label: formatAge(row.minutes_since_success) ?? "never synced",
    error: row.error,
  }));
}
