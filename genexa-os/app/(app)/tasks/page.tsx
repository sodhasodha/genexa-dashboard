import Link from "next/link";
import { addTask, deleteTask, editTask, moveTask, setTaskStatus } from "@/lib/actions/tasks";
import { requireStaff } from "@/lib/auth/staff";
import { categoriesFor, getClinicOptions, getTaskBoard, getTaskOwners, type TaskRow } from "@/lib/queries/tasks";

const ERRORS: Record<string, string> = {
  invalid: "Check the task: it needs a title, and the due date must be a real date.",
  owner_list: "Only Ryan can add to Ryan's list. The task was not added.",
  category: "The media buyer's tasks must be Ads or Call centre. The task was not saved.",
  deleted_match: "This matches a task that was deleted from this list, so it was not added again.",
  status_only: "You can only change the status or group of your own tasks. Editing and deleting are for Ryan.",
  not_allowed: "You cannot change that task. You can change the status of tasks on your own list only.",
  parent: "The parent task must be an open task on the same list.",
  save: "The task could not be saved.",
};
const SAVED: Record<string, string> = {
  added: "Task added.",
  status: "Status updated.",
  moved: "Task moved.",
  edited: "Task saved.",
  deleted: "Task deleted. Its title is kept so automated sources cannot add it back.",
};
const CATEGORY: Record<string, string> = { ads: "Ads", call_centre: "Call centre", tech: "Tech", general: "General" };
const PRIORITY: Record<string, string> = { high: "High", medium: "Medium", low: "Low" };
const STATUS: Record<string, string> = { todo: "To do", doing: "Doing", stuck: "Stuck", done: "Done" };
const SOURCE: Record<string, string> = { ryan: "Ryan", staff: "Team", pushpin: "Pushpin", claude: "Claude", call: "Call", slack: "Slack", system: "System" };
const OPEN_GROUPS = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "later", label: "Later" },
];
const PRIORITY_CLASS: Record<string, string> = { high: "bg-bad-bg text-bad", medium: "bg-warn-bg text-warn", low: "bg-stale-bg text-muted" };
const STATUS_CLASS: Record<string, string> = { todo: "bg-stale-bg text-muted", doing: "bg-raised text-ink", stuck: "bg-bad-bg text-bad", done: "bg-good-bg text-good" };
const INDENT = ["pl-3", "pl-8", "pl-12", "pl-16"];

const field = "rounded border border-line px-1.5 py-1";
const button = "cursor-pointer rounded bg-accent px-2 py-1 text-xs font-medium text-white";
const quiet = "cursor-pointer rounded border border-line px-2 py-1 text-xs";

function NoData() {
  return <span className="text-stale">no data</span>;
}

function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs ${className}`}>{children}</span>;
}

function TaskFields({ task, categories, clinics }: { task?: TaskRow; categories: string[]; clinics: { id: string; name: string }[] }) {
  return (
    <>
      <label className="flex flex-col gap-1 text-xs text-muted sm:col-span-2">
        Title
        <input name="title" required maxLength={300} defaultValue={task?.title ?? ""} className={`${field} text-sm`} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Category
        <select name="category" defaultValue={task?.category ?? categories[0]} className={`${field} text-sm`}>
          {categories.map((c) => <option key={c} value={c}>{CATEGORY[c] ?? c}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Priority
        <select name="priority" defaultValue={task?.priority ?? "medium"} className={`${field} text-sm`}>
          {Object.entries(PRIORITY).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Due
        <input type="date" name="due" defaultValue={task?.due ?? ""} className={`${field} text-sm`} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Clinic
        <select name="client_id" defaultValue={task?.client_id ?? ""} className={`${field} text-sm`}>
          <option value="">No clinic</option>
          {clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted sm:col-span-2">
        Notes
        <textarea name="notes" rows={2} maxLength={4000} defaultValue={task?.notes ?? ""} className={`${field} text-sm`} />
      </label>
    </>
  );
}

export default async function TasksPage({ searchParams }: PageProps<"/tasks">) {
  const me = await requireStaff();
  const params = await searchParams;
  const owners = await getTaskOwners();
  const asked = typeof params.owner === "string" ? params.owner : me.id;
  const owner = owners.find((o) => o.owner_id === asked) ?? owners.find((o) => o.owner_id === me.id);

  const error = typeof params.error === "string" ? ERRORS[params.error] : undefined;
  const saved = typeof params.saved === "string" ? SAVED[params.saved] : undefined;

  if (!owner) {
    return (
      <div className="p-4">
        <h1 className="text-lg font-semibold">Tasks</h1>
        <p className="mt-2 text-muted">No task lists to show.</p>
      </div>
    );
  }

  const [board, clinics] = await Promise.all([getTaskBoard(owner), getClinicOptions()]);
  const isOwner = me.role === "owner";
  const ownList = owner.owner_id === me.id;
  const canProgress = isOwner || ownList;
  const canAdd = isOwner || owner.role !== "owner";
  const categories = categoriesFor(owner.role);
  const columns = canProgress ? 9 : 8;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h1 className="text-lg font-semibold">Tasks</h1>
        {error ? <p className="mt-2 rounded bg-bad-bg px-3 py-2 text-bad">{error}</p> : null}
        {saved ? <p className="mt-2 rounded bg-good-bg px-3 py-2 text-good">{saved}</p> : null}
      </div>

      <nav className="flex flex-wrap gap-1.5" aria-label="Task lists">
        {owners.map((o) => (
          <Link
            key={o.owner_id}
            href={`/tasks?owner=${o.owner_id}`}
            aria-current={o.owner_id === owner.owner_id ? "page" : undefined}
            className={`rounded border px-2.5 py-1 text-sm ${o.owner_id === owner.owner_id ? "border-accent bg-raised font-medium" : "border-line bg-panel text-muted"}`}
          >
            {o.name}
            <span className="ml-1.5 tabular-nums text-muted">{o.open_tasks}</span>
            {o.overdue_tasks > 0 ? <span className="ml-1.5 tabular-nums text-bad">{o.overdue_tasks} overdue</span> : null}
          </Link>
        ))}
      </nav>

      <div className="text-xs text-muted">
        {owner.role === "owner" ? <p>Only {owner.name} can add to this list.</p> : null}
        {owner.role === "media_buyer" ? <p>Tasks on this list must be Ads or Call centre.</p> : null}
        {!isOwner ? (
          <p>
            {ownList ? "You can change the status and group of your own tasks." : "You can read this list and add to it, but not change its tasks."} Editing
            and deleting are for the owner.
          </p>
        ) : (
          <p>Deleting keeps the task&apos;s title on record, so automated sources cannot add the same task back.</p>
        )}
      </div>

      {canAdd ? (
        <details className="rounded border border-line bg-panel">
          <summary className="px-3 py-2 font-medium">Add a task to {owner.name}&apos;s list</summary>
          <form action={addTask} className="grid gap-3 border-t border-line p-3 sm:grid-cols-2 lg:grid-cols-4">
            <input type="hidden" name="list" value={owner.owner_id} />
            <input type="hidden" name="owner_id" value={owner.owner_id} />
            <TaskFields categories={categories} clinics={clinics} />
            <label className="flex flex-col gap-1 text-xs text-muted">
              Group
              <select name="task_group" defaultValue="week" className={`${field} text-sm`}>
                {OPEN_GROUPS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Subtask of
              <select name="parent_task_id" defaultValue="" className={`${field} text-sm`}>
                <option value="">Not a subtask</option>
                {board.parents.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              </select>
            </label>
            <div className="flex items-end">
              <button type="submit" className={button}>Add task</button>
            </div>
          </form>
        </details>
      ) : null}

      <div className="overflow-x-auto rounded border border-line bg-panel">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-normal">Title</th>
              <th className="px-3 py-2 font-normal">Clinic</th>
              <th className="px-3 py-2 font-normal">Category</th>
              <th className="px-3 py-2 font-normal">Priority</th>
              <th className="px-3 py-2 font-normal">Due</th>
              <th className="px-3 py-2 font-normal">Status</th>
              <th className="px-3 py-2 font-normal">Source</th>
              <th className="px-3 py-2 font-normal">Notes</th>
              {canProgress ? <th className="px-3 py-2 font-normal">Change</th> : null}
            </tr>
          </thead>
          {board.groups.map((g) => (
            <tbody key={g.key}>
              <tr className="border-b border-line bg-raised">
                <th colSpan={columns} className="px-3 py-1.5 text-left text-xs font-semibold">
                  {g.label}
                  <span className="ml-2 font-normal tabular-nums text-muted">{g.count}</span>
                </th>
              </tr>
              {g.tasks.length === 0 ? (
                <tr className="border-b border-line">
                  <td colSpan={columns} className="px-3 py-2 text-muted">Nothing here.</td>
                </tr>
              ) : null}
              {g.tasks.map((t) => (
                <tr key={t.id} className="border-b border-line align-top">
                  <td className={`py-2 pr-3 ${INDENT[Math.min(t.depth, INDENT.length - 1)]}`}>
                    <span className="font-medium">
                      {t.depth > 0 ? <span className="mr-1 text-muted" aria-label="subtask">↳</span> : null}
                      {t.title}
                    </span>
                    {t.parent_title ? <span className="block text-xs text-muted">subtask of {t.parent_title}</span> : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{t.client_name ?? <NoData />}</td>
                  <td className="whitespace-nowrap px-3 py-2">{CATEGORY[t.category] ?? t.category}</td>
                  <td className="px-3 py-2">
                    <Pill className={PRIORITY_CLASS[t.priority] ?? "bg-stale-bg text-muted"}>{PRIORITY[t.priority] ?? t.priority}</Pill>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                    {t.due_label ?? <NoData />}
                    {t.days_overdue !== null ? (
                      <span className="block text-xs font-semibold text-bad">
                        overdue {t.days_overdue} {t.days_overdue === 1 ? "day" : "days"}
                      </span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <Pill className={STATUS_CLASS[t.status] ?? "bg-stale-bg text-muted"}>{STATUS[t.status] ?? t.status}</Pill>
                    {g.key === "done" ? <span className="block text-xs text-muted">{t.done_label ?? "no data"}</span> : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{SOURCE[t.source] ?? t.source}</td>
                  <td className="max-w-xs whitespace-pre-wrap px-3 py-2">{t.notes ?? <NoData />}</td>
                  {canProgress ? (
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-1.5">
                        <form action={setTaskStatus} className="flex items-center gap-1">
                          <input type="hidden" name="list" value={owner.owner_id} />
                          <input type="hidden" name="id" value={t.id} />
                          <select name="status" defaultValue={t.status} aria-label={`Status of ${t.title}`} className={`${field} text-xs`}>
                            {Object.entries(STATUS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                          </select>
                          <button type="submit" className={quiet}>Set</button>
                        </form>
                        {g.key !== "done" ? (
                          <form action={moveTask} className="flex items-center gap-1">
                            <input type="hidden" name="list" value={owner.owner_id} />
                            <input type="hidden" name="id" value={t.id} />
                            <select name="task_group" defaultValue={t.task_group} aria-label={`Group of ${t.title}`} className={`${field} text-xs`}>
                              {OPEN_GROUPS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                            </select>
                            <button type="submit" className={quiet}>Move</button>
                          </form>
                        ) : null}
                        {isOwner ? (
                          <details>
                            <summary className="text-xs text-muted">Edit or delete</summary>
                            <form action={editTask} className="mt-2 grid w-72 gap-2 sm:grid-cols-2">
                              <input type="hidden" name="list" value={owner.owner_id} />
                              <input type="hidden" name="id" value={t.id} />
                              <TaskFields task={t} categories={categories} clinics={clinics} />
                              <div>
                                <button type="submit" className={button}>Save</button>
                              </div>
                            </form>
                            <form action={deleteTask} className="mt-2">
                              <input type="hidden" name="list" value={owner.owner_id} />
                              <input type="hidden" name="id" value={t.id} />
                              <button type="submit" className="cursor-pointer rounded bg-bad-bg px-2 py-1 text-xs font-medium text-bad">Delete task</button>
                            </form>
                          </details>
                        ) : null}
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  );
}
