"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOwner, requireStaff } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";
import { blank, Day, Id } from "./fields";

const Category = z.enum(["ads", "call_centre", "tech", "general"]);
const Priority = z.enum(["high", "medium", "low"]);
const Status = z.enum(["todo", "doing", "stuck", "done"]);
const OpenGroup = z.enum(["today", "week", "later"]);

const Details = z.object({
  title: z.string().min(1).max(300),
  category: Category,
  priority: Priority,
  due: Day.nullable(),
  client_id: Id.nullable(),
  notes: z.string().max(4000).nullable(),
});
const NewTask = Details.extend({ owner_id: Id, parent_task_id: Id.nullable(), task_group: OpenGroup });

/** Back to the list the form was on, with a result in the query string. */
function back(formData: FormData, result: string): never {
  const list = Id.safeParse(formData.get("list"));
  revalidatePath("/tasks");
  redirect(list.success ? `/tasks?owner=${list.data}&${result}` : `/tasks?${result}`);
}

/** The database's task rules, as the error code the page explains. */
function reason(message: string): string {
  if (message.includes("TASK_OWNER_LIST")) return "owner_list";
  if (message.includes("TASK_CATEGORY")) return "category";
  if (message.includes("TASK_DELETED_MATCH")) return "deleted_match";
  if (message.includes("TASK_STATUS_ONLY")) return "status_only";
  if (message.includes("row-level security")) return "not_allowed";
  return "save";
}

function details(formData: FormData) {
  return {
    title: blank(formData.get("title")) ?? "",
    category: formData.get("category"),
    priority: formData.get("priority"),
    due: blank(formData.get("due")),
    client_id: blank(formData.get("client_id")),
    notes: blank(formData.get("notes")),
  };
}

/** Anyone on the team adds a task. The database decides whether that list accepts it. */
export async function addTask(formData: FormData) {
  const me = await requireStaff();
  const parsed = NewTask.safeParse({
    ...details(formData),
    owner_id: formData.get("owner_id"),
    parent_task_id: blank(formData.get("parent_task_id")),
    task_group: formData.get("task_group"),
  });
  if (!parsed.success) back(formData, "error=invalid");
  const task = parsed.data;

  const supabase = await createClient();
  if (task.parent_task_id) {
    const { data: parent } = await supabase.from("task_list").select("owner_id").eq("id", task.parent_task_id).maybeSingle();
    if (!parent || parent.owner_id !== task.owner_id) back(formData, "error=parent");
  }
  const { error } = await supabase.from("tasks").insert({ ...task, source: me.role === "owner" ? "ryan" : "staff" });
  if (error) back(formData, `error=${reason(error.message)}`);
  back(formData, "saved=added");
}

/** Status of a task: the app owner on any task, anyone else on their own (RLS + tasks_rules). */
export async function setTaskStatus(formData: FormData) {
  await requireStaff();
  const id = Id.safeParse(formData.get("id"));
  const status = Status.safeParse(formData.get("status"));
  if (!id.success || !status.success) back(formData, "error=invalid");
  const supabase = await createClient();
  const { data, error } = await supabase.from("tasks").update({ status: status.data }).eq("id", id.data).is("deleted_at", null).select("id");
  if (error) back(formData, `error=${reason(error.message)}`);
  if (!data || data.length === 0) back(formData, "error=not_allowed");
  back(formData, "saved=status");
}

/** Move an open task between Today, This week and Later. Done is reached by setting the status. */
export async function moveTask(formData: FormData) {
  await requireStaff();
  const id = Id.safeParse(formData.get("id"));
  const group = OpenGroup.safeParse(formData.get("task_group"));
  if (!id.success || !group.success) back(formData, "error=invalid");
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tasks")
    .update({ task_group: group.data })
    .eq("id", id.data)
    .neq("status", "done")
    .is("deleted_at", null)
    .select("id");
  if (error) back(formData, `error=${reason(error.message)}`);
  if (!data || data.length === 0) back(formData, "error=not_allowed");
  back(formData, "saved=moved");
}

/** App owner edits a task's details. */
export async function editTask(formData: FormData) {
  await requireOwner();
  const id = Id.safeParse(formData.get("id"));
  const parsed = Details.safeParse(details(formData));
  if (!id.success || !parsed.success) back(formData, "error=invalid");
  const supabase = await createClient();
  const { data, error } = await supabase.from("tasks").update(parsed.data).eq("id", id.data).is("deleted_at", null).select("id");
  if (error) back(formData, `error=${reason(error.message)}`);
  if (!data || data.length === 0) back(formData, "error=not_allowed");
  back(formData, "saved=edited");
}

/** App owner deletes a task: a soft delete. tasks_rules records the title in deleted_tasks. */
export async function deleteTask(formData: FormData) {
  await requireOwner();
  const id = Id.safeParse(formData.get("id"));
  if (!id.success) back(formData, "error=invalid");
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tasks")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id.data)
    .is("deleted_at", null)
    .select("id");
  if (error) back(formData, `error=${reason(error.message)}`);
  if (!data || data.length === 0) back(formData, "error=not_allowed");
  back(formData, "saved=deleted");
}
