import "server-only";
import { createClient } from "@/lib/supabase/server";

export type TeamMember = {
  id: string;
  name: string;
  role: string;
  also_role: string | null;
  pod: string | null;
  status: string;
  timezone: string;
  shift_start: string | null;
  shift_end: string | null;
  working_days: number[];
  has_login: boolean;
};

export type CoverageHour = {
  isodow: number;
  et_hour: number;
  csrs_on: number;
  tech_on: number;
  media_on: number;
  who: string | null;
  cover_expected: boolean;
  csr_gap: boolean;
};

export async function getTeam(): Promise<TeamMember[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("staff")
    .select("id, name, role, also_role, pod, status, timezone, shift_start, shift_end, working_days, auth_user_id")
    .neq("status", "left")
    .order("role")
    .order("pod")
    .order("name");
  if (error) throw new Error(`staff: ${error.message}`);
  return (data ?? []).map(({ auth_user_id, ...s }) => ({ ...s, has_login: auth_user_id !== null }));
}

/** 7 x 24 rows from team_coverage_summary: who is on for every ET hour of this week. */
export async function getCoverage(): Promise<CoverageHour[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("team_coverage_summary")
    .select("isodow, et_hour, csrs_on, tech_on, media_on, who, cover_expected, csr_gap")
    .order("isodow")
    .order("et_hour");
  if (error) throw new Error(`team_coverage_summary: ${error.message}`);
  return (data ?? []) as CoverageHour[];
}
