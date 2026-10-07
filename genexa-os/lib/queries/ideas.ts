import "server-only";
import { createClient } from "@/lib/supabase/server";
import { formatDay } from "./dates";

export type Idea = { id: string; text: string; source: string | null; day_label: string | null };

/** Live ideas, newest first (view idea_list; the day is cut in ET). */
export async function getIdeas(): Promise<Idea[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("idea_list").select("id, text, source, created_day").order("created_at", { ascending: false });
  if (error) throw new Error(`idea_list: ${error.message}`);
  return (data ?? []).map((r) => ({ id: r.id, text: r.text, source: r.source, day_label: formatDay(r.created_day) }));
}
