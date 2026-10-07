"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOwner, requireStaff } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";
import { blank, Id } from "./fields";

const NewIdea = z.object({ text: z.string().min(1).max(4000), source: z.string().max(200).nullable() });

function back(result: string): never {
  revalidatePath("/ideas");
  redirect(`/ideas?${result}`);
}

/** Anyone on the team adds an idea (policy staff_insert on ideas). */
export async function addIdea(formData: FormData) {
  await requireStaff();
  const parsed = NewIdea.safeParse({ text: blank(formData.get("text")) ?? "", source: blank(formData.get("source")) });
  if (!parsed.success) back("error=invalid");
  const supabase = await createClient();
  const { error } = await supabase.from("ideas").insert(parsed.data);
  if (error) back("error=save");
  back("saved=added");
}

/** App owner removes an idea: a soft delete. */
export async function deleteIdea(formData: FormData) {
  await requireOwner();
  const id = Id.safeParse(formData.get("id"));
  if (!id.success) back("error=invalid");
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ideas")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id.data)
    .is("deleted_at", null)
    .select("id");
  if (error || !data || data.length === 0) back("error=save");
  back("saved=deleted");
}
