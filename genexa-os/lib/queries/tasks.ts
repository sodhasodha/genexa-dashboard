import "server-only";
import { UK, countdown, formatDeadline, instantToLocal } from "@/lib/deadlines";
import { createClient } from "@/lib/supabase/server";
import { formatDay } from "./dates";

export const TASK_GROUPS = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "later", label: "Later" },
  { key: "done", label: "Done" },
] as const;
export type TaskGroupKey = (typeof TASK_GROUPS)[number]["key"];

/** How many done tasks the page shows per list. */
export const DONE_SHOWN = 30;

export type TaskOwner = {
  owner_id: string;
  name: string;
  role: string;
  open_tasks: number;
  overdue_tasks: number;
  done_tasks: number;
  /** This person's tasks carry a date and time deadline, and it is required (staff_has_timed_deadlines). */
  timed_deadlines: boolean;
  /** The timezone they read deadlines in. */
  timezone: string;
};

export type TaskRow = {
  id: string;
  title: string;
  /** 0 for a top-level task, 1 for a subtask shown under its parent, and so on. */
  depth: number;
  /** Set when this is a subtask whose parent sits in another group. */
  parent_title: string | null;
  client_id: string | null;
  client_name: string | null;
  category: string;
  priority: string;
  due: string | null;
  due_label: string | null;
  days_overdue: number | null;
  /** The deadline instant, when the task has a time. */
  due_at: string | null;
  /** The deadline as the task's owner reads it, e.g. "Wed 14 Oct, 19:30 IST". */
  deadline_label: string | null;
  /** The same instant in UK time, e.g. "Wed 14 Oct, 15:00 BST". */
  deadline_uk_label: string | null;
  /** UK wall-clock value for the edit form's date and time boxes: "2026-10-14T15:00". */
  deadline_uk_input: string;
  /** "due in 3h" / "2h overdue", worked out when the page was rendered. Null without a time or when done. */
  countdown: string | null;
  is_overdue: boolean;
  status: string;
  task_group: TaskGroupKey;
  source: string;
  notes: string | null;
  done_label: string | null;
};

export type TaskBoard = {
  /** count is what the group heading shows: the number of tasks, or "latest 30 of 112" for a long Done group. */
  groups: { key: TaskGroupKey; label: string; count: string; tasks: TaskRow[] }[];
  /** Open tasks on this list that a new task can be filed under. */
  parents: { id: string; title: string }[];
};

type Raw = Omit<TaskRow, "depth" | "due_label" | "done_label" | "deadline_label" | "deadline_uk_label" | "deadline_uk_input" | "countdown"> & {
  parent_task_id: string | null;
  done_day: string | null;
  done_rank: number | null;
  minutes_to_deadline: number | null;
  owner_timezone: string | null;
};

/** Everyone who can hold tasks, with open and overdue counts (view task_owners). */
export async function getTaskOwners(): Promise<TaskOwner[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("task_owners")
    .select("owner_id, name, role, open_tasks, overdue_tasks, done_tasks, timed_deadlines, timezone")
    .order("name");
  if (error) throw new Error(`task_owners: ${error.message}`);
  const owners = (data ?? []) as TaskOwner[];
  // The app owner's list first, then everyone else by name.
  return [...owners.filter((o) => o.role === "owner"), ...owners.filter((o) => o.role !== "owner")];
}

/** The categories a list accepts. The media buyer's list takes ads and call centre only (tasks_rules). */
export function categoriesFor(role: string): string[] {
  return role === "media_buyer" ? ["ads", "call_centre"] : ["general", "ads", "call_centre", "tech"];
}

/** Parents first, each followed by its subtasks. A subtask whose parent is not in the same group stays top-level. */
function nest(rows: Raw[]): TaskRow[] {
  const ids = new Set(rows.map((r) => r.id));
  const children = new Map<string, Raw[]>();
  const top: Raw[] = [];
  for (const r of rows) {
    if (r.parent_task_id && r.parent_task_id !== r.id && ids.has(r.parent_task_id)) {
      children.set(r.parent_task_id, [...(children.get(r.parent_task_id) ?? []), r]);
    } else {
      top.push(r);
    }
  }
  const out: TaskRow[] = [];
  const seen = new Set<string>();
  const walk = (r: Raw, depth: number) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    out.push({
      id: r.id,
      title: r.title,
      depth,
      parent_title: depth === 0 ? r.parent_title : null,
      client_id: r.client_id,
      client_name: r.client_name,
      category: r.category,
      priority: r.priority,
      due: r.due,
      due_label: formatDay(r.due),
      days_overdue: r.days_overdue,
      due_at: r.due_at,
      deadline_label: formatDeadline(r.due_at, r.owner_timezone),
      deadline_uk_label: formatDeadline(r.due_at, UK),
      deadline_uk_input: instantToLocal(r.due_at),
      countdown: countdown(r.minutes_to_deadline),
      is_overdue: r.is_overdue === true,
      status: r.status,
      task_group: r.task_group,
      source: r.source,
      notes: r.notes,
      done_label: formatDay(r.done_day),
    });
    for (const c of children.get(r.id) ?? []) walk(c, depth + 1);
  };
  for (const r of top) walk(r, 0);
  for (const r of rows) walk(r, 0); // anything left is a loop of parents; show it flat rather than lose it
  return out;
}

/**
 * One person's list, grouped. Done holds the most recent 30 only (done_rank in task_list).
 * A timed-deadline person's list is in deadline order: most overdue first, then due soonest,
 * then tasks without a deadline (deadline_at in task_list). Everyone else: priority, then due date.
 */
export async function getTaskBoard(owner: TaskOwner): Promise<TaskBoard> {
  const supabase = await createClient();
  const query = supabase
    .from("task_list")
    .select(
      "id, parent_task_id, parent_title, title, client_id, client_name, category, priority, due, days_overdue, due_at, is_overdue, minutes_to_deadline, owner_timezone, status, task_group, source, notes, done_day, done_rank",
    )
    .eq("owner_id", owner.owner_id)
    .or(`done_rank.is.null,done_rank.lte.${DONE_SHOWN}`);
  const { data, error } = await (owner.timed_deadlines
    ? query.order("deadline_at", { ascending: true, nullsFirst: false }).order("priority_rank").order("created_at")
    : query.order("priority_rank").order("due", { nullsFirst: false }).order("created_at"));
  if (error) throw new Error(`task_list: ${error.message}`);
  const rows = (data ?? []) as Raw[];
  const groups = TASK_GROUPS.map((g) => {
    const inGroup = rows.filter((r) => r.task_group === g.key);
    if (g.key === "done") inGroup.sort((a, b) => (a.done_rank ?? 0) - (b.done_rank ?? 0));
    const count =
      g.key === "done" && owner.done_tasks > inGroup.length ? `latest ${inGroup.length} of ${owner.done_tasks}` : String(inGroup.length);
    return { key: g.key, label: g.label, count, tasks: nest(inGroup) };
  });
  const parents = rows.filter((r) => r.task_group !== "done").map((r) => ({ id: r.id, title: r.title }));
  return { groups, parents };
}

/** Clinics a task can be tied to. */
export async function getClinicOptions(): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("clients").select("id, name").is("deleted_at", null).order("name");
  if (error) throw new Error(`clients: ${error.message}`);
  return data ?? [];
}
