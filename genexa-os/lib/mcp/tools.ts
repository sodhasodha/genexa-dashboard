// The MCP tools. Each one validates its arguments, calls one SQL function through
// McpData and hands back what the database returned. No metric is computed here.
import { z } from "zod";
import { resolvePeriod } from "@/lib/periods";
import { McpDbError, type McpData } from "@/lib/mcp/data";

export type ToolContext = {
  data: McpData;
  /** Today's date in ET, YYYY-MM-DD. */
  today: string;
};

type JsonSchema = {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
};

export type Tool = {
  name: string;
  description: string;
  /** true = changes nothing. */
  readOnly: boolean;
  inputSchema: JsonSchema;
  /** Validates the arguments. Kept in step with inputSchema by tests/unit/mcp.test.ts. */
  args: z.ZodType<Record<string, unknown>>;
  run(args: never, ctx: ToolContext): Promise<Record<string, unknown>>;
};

/** A tool that could not do what was asked. Returned to the caller as isError, never as a 500. */
export class ToolError extends Error {
  constructor(readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ToolError";
  }
}

// ---------------------------------------------------------------------------
// The three task rules. Checked here first and again by the tasks_rules trigger.
// ---------------------------------------------------------------------------
export const TASK_RULES = {
  TASK_OWNER_LIST: "Ryan's list only accepts tasks with source = pushpin.",
  TASK_CATEGORY: "The media buyer's tasks must have category ads or call_centre.",
  TASK_DELETED_MATCH: "A title that matches a task the owner deleted is not added again.",
} as const;
type TaskRule = keyof typeof TASK_RULES;

const taskRuleError = (code: TaskRule, message: string, enforcedBy: "endpoint" | "database", extra: Record<string, unknown> = {}) =>
  new ToolError(code, message, { rule: TASK_RULES[code], enforced_by: enforcedBy, ...extra });

const CODED = /\b((?:TASK|MCP)_[A-Z_]+):\s*([\s\S]*)$/;

/** Turns anything a tool threw into a ToolError with a code the caller can act on. */
export function toToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  if (err instanceof McpDbError) {
    const m = CODED.exec(err.message);
    if (m) {
      const [, code, message] = m;
      if (code in TASK_RULES) return taskRuleError(code as TaskRule, message, "database");
      return new ToolError(code.replace(/^MCP_/, ""), message);
    }
    return new ToolError("DATABASE_ERROR", err.message);
  }
  return new ToolError("INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Argument pieces
// ---------------------------------------------------------------------------
const id = z.guid("must be a uuid");
const date = z.iso.date("must be a date, YYYY-MM-DD");
const text = (max: number) => z.string().trim().min(1, "must not be empty").max(max);
const isMonday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay() === 1;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

const S = {
  id: (description: string) => ({ type: "string", format: "uuid", description }),
  date: (description: string) => ({ type: "string", format: "date", description }),
  text: (description: string, maxLength?: number) => ({ type: "string", minLength: 1, ...(maxLength ? { maxLength } : {}), description }),
  pick: (values: readonly string[], description: string) => ({ type: "string", enum: [...values], description }),
};
const schema = (properties: JsonSchema["properties"], required: string[] = []): JsonSchema => ({
  type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false,
});

const PERIOD = ["today", "week", "month", "last_month"] as const;
const WINDOW = ["3d", "7d", "all"] as const;
const WINDOW_DAYS: Record<(typeof WINDOW)[number], number | undefined> = { "3d": 3, "7d": 7, all: undefined };
const EXCEPTION_STATUS = ["open", "snoozed", "resolved"] as const;
const JOB_STATUS = ["todo", "working", "stuck", "done"] as const;
const TASK_CATEGORY = ["ads", "call_centre", "tech", "general"] as const;
const TASK_SOURCE = ["pushpin", "claude", "call", "slack", "system"] as const;
const BRIEF_KIND = ["daily", "weekly"] as const;
const TOUCH_KIND = ["call", "loom", "report", "slack", "email"] as const;
const HEAT = ["hot", "warm", "cold"] as const;
const PROSPECT_STAGE = ["chase", "contract_out", "paid", "dead"] as const;
const MAX_EOD_DAYS = 92;

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function tool<A extends Record<string, unknown>>(def: {
  name: string; description: string; readOnly: boolean; inputSchema: JsonSchema; args: z.ZodType<A>;
  run(args: A, ctx: ToolContext): Promise<Record<string, unknown>>;
}): Tool {
  return def as unknown as Tool;
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------
const read: Tool[] = [
  tool({
    name: "get_overview",
    description:
      "Agency Overview numbers for a period and the period before it (ad spend, leads, booked, confirmed, shows, no-shows, closes, clinic revenue, cash collected, expenses, bank revenue), plus MRR, open exceptions with $ at risk, clients by stage and how fresh each source is. Default period: month.",
    readOnly: true,
    inputSchema: schema({ period: S.pick(PERIOD, "Reporting period, cut in US Eastern time. Default month (month to date).") }),
    args: z.strictObject({ period: z.enum(PERIOD).optional() }),
    async run({ period }, { data, today }) {
      const p = resolvePeriod(period ?? "month", today);
      const numbers = await data.call("mcp_get_overview", { p_from: p.from, p_to: p.to, p_prev_from: p.prevFrom, p_prev_to: p.prevTo });
      return {
        period: { key: p.key, label: p.label, from: p.from, to: p.to, previous_from: p.prevFrom, previous_to: p.prevTo, previous_label: p.prevLabel },
        ...asObject(numbers),
      };
    },
  }),
  tool({
    name: "get_clients",
    description:
      "Every client that is not deleted: stage, pod, health colour and reasons, monthly fee and where it comes from, next renewal and its status, this month's numbers, next action, last contact and last client reply, and whether Cortana is connected.",
    readOnly: true,
    inputSchema: schema({}),
    args: z.strictObject({}),
    async run(_args, { data }) {
      return { clients: asList(await data.call("mcp_get_clients")) };
    },
  }),
  tool({
    name: "get_client",
    description: "One client: everything get_clients returns for it, plus its open and snoozed exceptions, tech jobs and recent touches.",
    readOnly: true,
    inputSchema: schema({ id: S.id("Client id (from get_clients).") }, ["id"]),
    args: z.strictObject({ id }),
    async run(args, { data }) {
      return asObject(await data.call("mcp_get_client", { p_client_id: args.id }));
    },
  }),
  tool({
    name: "get_ad_metrics",
    description:
      "Ad numbers for one client. Account level for the window asked for (with days live, SOP stage and the 7-day cost-per-booked verdict), and ad level as Cortana reports it: 7 days and all time side by side.",
    readOnly: true,
    inputSchema: schema({ client_id: S.id("Client id."), window: S.pick(WINDOW, "Account-level window: last 3 days, last 7 days or all time.") }, ["client_id", "window"]),
    args: z.strictObject({ client_id: id, window: z.enum(WINDOW) }),
    async run(args, { data }) {
      const numbers = asObject(await data.call("mcp_get_ad_metrics", { p_client_id: args.client_id, p_days: WINDOW_DAYS[args.window] }));
      return {
        window: args.window,
        ...numbers,
        ad_level_windows: ["7d", "all"],
        ...(numbers.account === null || numbers.account === undefined
          ? { note: "No account-level numbers: this client is churned or has no Cortana business connected." }
          : {}),
      };
    },
  }),
  tool({
    name: "get_exceptions",
    description: "Exceptions in one status (default open), biggest $ at risk first, with the count and total $ at risk. At most 500 rows.",
    readOnly: true,
    inputSchema: schema({ status: S.pick(EXCEPTION_STATUS, "Default open.") }),
    args: z.strictObject({ status: z.enum(EXCEPTION_STATUS).optional() }),
    async run(args, { data }) {
      return asObject(await data.call("mcp_get_exceptions", { p_status: args.status ?? "open" }));
    },
  }),
  tool({
    name: "get_tech_jobs",
    description:
      "Tech jobs with their SLA figures (minutes allowed, Genexa minutes used, minutes paused, overdue, met SLA). With no status: every job that is not done. At most 300 rows.",
    readOnly: true,
    inputSchema: schema({ status: S.pick(JOB_STATUS, "Leave out for everything that is not done.") }),
    args: z.strictObject({ status: z.enum(JOB_STATUS).optional() }),
    async run(args, { data }) {
      return { status: args.status ?? "not_done", jobs: asList(await data.call("mcp_get_tech_jobs", { p_status: args.status })) };
    },
  }),
  tool({
    name: "get_launches",
    description: "The launch board: one row per launch with its stage, QC checklist, days waiting since payment and the 48-hour SLA clock.",
    readOnly: true,
    inputSchema: schema({}),
    args: z.strictObject({}),
    async run(_args, { data }) {
      return { launches: asList(await data.call("mcp_get_launches")) };
    },
  }),
  tool({
    name: "get_call_centre",
    description: "Call centre numbers. Not available yet: the call centre is moving to Hot Prospector and there is no call data source.",
    readOnly: true,
    inputSchema: schema({ window: { type: "string", description: "Ignored for now." } }),
    args: z.strictObject({ window: z.string().optional() }),
    async run() {
      return { status: "not_available", reason: "Call centre moves to Hot Prospector — not set up yet." };
    },
  }),
  tool({
    name: "get_scores",
    description: "Weekly scorecard rows (card, metric, value, numerator, denominator, colour) for every person, for one week. Default: the current week.",
    readOnly: true,
    inputSchema: schema({ week: S.date("The Monday the week starts on. Default: this week.") }),
    args: z.strictObject({ week: date.refine(isMonday, "must be a Monday").optional() }),
    async run(args, { data }) {
      return asObject(await data.call("mcp_get_scores", { p_week: args.week }));
    },
  }),
  tool({
    name: "get_eods",
    description: `End-of-day reports in a date range: who, which day, their role and their answers. At most ${MAX_EOD_DAYS} days per call.`,
    readOnly: true,
    inputSchema: schema({ from: S.date("First day, inclusive."), to: S.date("Last day, inclusive.") }, ["from", "to"]),
    args: z.strictObject({ from: date, to: date })
      .refine((a) => a.from <= a.to, { path: ["to"], message: "must not be before from" })
      .refine((a) => a.from > a.to || daysBetween(a.from, a.to) < MAX_EOD_DAYS, { path: ["to"], message: `range must be ${MAX_EOD_DAYS} days or fewer` }),
    async run(args, { data }) {
      return { from: args.from, to: args.to, eods: asList(await data.call("mcp_get_eods", { p_from: args.from, p_to: args.to })) };
    },
  }),
  tool({
    name: "get_tasks",
    description: "Open tasks (not deleted, not done) grouped by owner. Give an owner to see one person's list.",
    readOnly: true,
    inputSchema: schema({ owner: S.text("Staff name (full or first name) or staff id.") }),
    args: z.strictObject({ owner: text(200).optional() }),
    async run(args, { data }) {
      return { owners: asList(await data.call("mcp_get_tasks", { p_owner: args.owner })) };
    },
  }),
  tool({
    name: "get_prospects",
    description: "The sales pipeline: every prospect with heat, stage, what they want, objection, what was promised, follow-up date and deal size. Contact details are never included.",
    readOnly: true,
    inputSchema: schema({}),
    args: z.strictObject({}),
    async run(_args, { data }) {
      return { prospects: asList(await data.call("mcp_get_prospects")) };
    },
  }),
  tool({
    name: "get_agency_month",
    description: "One month of agency figures. The frozen snapshot when the month has been closed (frozen: true); otherwise the live figures for the month so far with today's MRR (frozen: false).",
    readOnly: true,
    inputSchema: schema({ month: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$", description: "YYYY-MM." } }, ["month"]),
    args: z.strictObject({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "must be a month, YYYY-MM") }),
    async run(args, { data, today }) {
      if (args.month > today.slice(0, 7)) throw new ToolError("INVALID", `${args.month} has not started yet.`);
      return asObject(await data.call("mcp_get_agency_month", { p_month: `${args.month}-01` }));
    },
  }),
  tool({
    name: "get_sync_status",
    description: "How fresh each data source is: last attempt, last success, minutes since, rows processed, last error and whether it is stale.",
    readOnly: true,
    inputSchema: schema({}),
    args: z.strictObject({}),
    async run(_args, { data }) {
      return { sources: asList(await data.call("mcp_get_sync_status")) };
    },
  }),
];

// ---------------------------------------------------------------------------
// Write tools. Audited as "claude". There are no delete tools.
// ---------------------------------------------------------------------------
const PROSPECT_FIELDS = ["heat", "state", "call_date", "what_they_want", "objection", "promised", "follow_up_date", "fathom_url", "deal_size", "stage"] as const;

const write: Tool[] = [
  tool({
    name: "write_brief",
    description: "Save the daily or weekly brief for a date. Writing the same date and kind again replaces it.",
    readOnly: false,
    inputSchema: schema(
      { date: S.date("The day the brief is for."), kind: S.pick(BRIEF_KIND, "daily or weekly."), markdown: S.text("The brief, in Markdown.", 100_000) },
      ["date", "kind", "markdown"]),
    args: z.strictObject({ date, kind: z.enum(BRIEF_KIND), markdown: text(100_000) }),
    async run(args, { data }) {
      return asObject(await data.call("mcp_write_brief", { p_date: args.date, p_kind: args.kind, p_markdown: args.markdown }));
    },
  }),
  tool({
    name: "add_task",
    description:
      "Add a task to someone's list. Rules: Ryan's list only accepts source = pushpin; the media buyer's tasks must be category ads or call_centre; a title that matches a task the owner deleted is refused.",
    readOnly: false,
    inputSchema: schema({
      owner: S.text("Staff name (full or first name) or staff id."),
      title: S.text("What needs doing.", 500),
      category: S.pick(TASK_CATEGORY, "Task category."),
      client_id: S.id("The client the task is about, if any."),
      due: S.date("Due date."),
      notes: S.text("Extra detail.", 5000),
      source: S.pick(TASK_SOURCE, "Where the task came from."),
    }, ["owner", "title", "category", "source"]),
    args: z.strictObject({
      owner: text(200), title: text(500), category: z.enum(TASK_CATEGORY), client_id: id.optional(),
      due: date.optional(), notes: text(5000).optional(), source: z.enum(TASK_SOURCE),
    }),
    async run(args, { data }) {
      const check = asObject(await data.call("mcp_task_check", { p_owner: args.owner, p_title: args.title }));
      const owner = asObject(check.owner);
      if (owner.role === "owner" && args.source !== "pushpin") {
        throw taskRuleError("TASK_OWNER_LIST", `${String(owner.name)}'s list only takes tasks with source = pushpin (got ${args.source}).`, "endpoint");
      }
      if (owner.role === "media_buyer" && args.category !== "ads" && args.category !== "call_centre") {
        throw taskRuleError("TASK_CATEGORY", `${String(owner.name)} is the media buyer: category must be ads or call_centre (got ${args.category}).`, "endpoint");
      }
      if (check.deleted_match) {
        const match = asObject(check.deleted_match);
        throw taskRuleError("TASK_DELETED_MATCH", `${String(owner.name)} deleted a task like this: "${String(match.title)}".`, "endpoint", { matched: match });
      }
      return asObject(await data.call("mcp_add_task", {
        p_owner: String(owner.id), p_title: args.title, p_category: args.category, p_source: args.source,
        p_client_id: args.client_id, p_due: args.due, p_notes: args.notes,
      }));
    },
  }),
  tool({
    name: "add_idea",
    description: "Add an idea to the ideas list.",
    readOnly: false,
    inputSchema: schema({ text: S.text("The idea.", 5000), source: S.text("Where it came from, e.g. claude, call, slack.", 100) }, ["text", "source"]),
    args: z.strictObject({ text: text(5000), source: text(100) }),
    async run(args, { data }) {
      return asObject(await data.call("mcp_add_idea", { p_text: args.text, p_source: args.source }));
    },
  }),
  tool({
    name: "upsert_prospect",
    description:
      "Create a prospect or update the one with the same name (case-insensitive). Only the fields you give are changed. Contact details cannot be written here.",
    readOnly: false,
    inputSchema: schema({
      name: S.text("Prospect name. Used to find an existing prospect.", 300),
      heat: S.pick(HEAT, "How warm the lead is."),
      state: S.text("US state.", 100),
      call_date: S.date("Date of the sales call."),
      what_they_want: S.text("What they want.", 5000),
      objection: S.text("Their objection.", 5000),
      promised: S.text("What we promised.", 5000),
      follow_up_date: S.date("When to follow up."),
      fathom_url: { type: "string", format: "uri", description: "Link to the call recording." },
      deal_size: { type: "number", minimum: 0, description: "Deal size in USD." },
      stage: S.pick(PROSPECT_STAGE, "Pipeline stage. A new prospect starts in chase."),
    }, ["name"]),
    args: z.strictObject({
      name: text(300), heat: z.enum(HEAT).optional(), state: text(100).optional(), call_date: date.optional(),
      what_they_want: text(5000).optional(), objection: text(5000).optional(), promised: text(5000).optional(),
      follow_up_date: date.optional(), fathom_url: z.url("must be a URL").max(2000).optional(),
      deal_size: z.number().nonnegative().finite().optional(), stage: z.enum(PROSPECT_STAGE).optional(),
    }),
    async run(args, { data }) {
      // Only the listed fields travel; anything else (contact included) cannot be sent.
      const given: Record<string, unknown> = args;
      const fields = Object.fromEntries(PROSPECT_FIELDS.filter((k) => given[k] !== undefined).map((k) => [k, given[k]]));
      return asObject(await data.call("mcp_upsert_prospect", { p_name: args.name, p_fields: fields }));
    },
  }),
  tool({
    name: "set_next_action",
    description: "Set a client's next action.",
    readOnly: false,
    inputSchema: schema({ client_id: S.id("Client id."), text: S.text("The next action.", 2000) }, ["client_id", "text"]),
    args: z.strictObject({ client_id: id, text: text(2000) }),
    async run(args, { data }) {
      return asObject(await data.call("mcp_set_next_action", { p_client_id: args.client_id, p_text: args.text }));
    },
  }),
  tool({
    name: "log_touch",
    description: "Log a contact with a client (call, loom, report, slack or email). Also moves the client's last-contact date forward.",
    readOnly: false,
    inputSchema: schema(
      { client_id: S.id("Client id."), kind: S.pick(TOUCH_KIND, "How we contacted them."), note: S.text("What was said or sent.", 5000) },
      ["client_id", "kind", "note"]),
    args: z.strictObject({ client_id: id, kind: z.enum(TOUCH_KIND), note: text(5000) }),
    async run(args, { data }) {
      return asObject(await data.call("mcp_log_touch", { p_client_id: args.client_id, p_kind: args.kind, p_note: args.note }));
    },
  }),
  tool({
    name: "set_exception_action",
    description: "Record the action taken on an exception. Does not resolve or snooze it.",
    readOnly: false,
    inputSchema: schema({ id: S.id("Exception id (from get_exceptions)."), text: S.text("The action taken.", 2000) }, ["id", "text"]),
    args: z.strictObject({ id, text: text(2000) }),
    async run(args, { data }) {
      return asObject(await data.call("mcp_set_exception_action", { p_id: args.id, p_text: args.text }));
    },
  }),
];

export const TOOLS: Tool[] = [...read, ...write];
export const findTool = (name: string): Tool | undefined => TOOLS.find((t) => t.name === name);

/** "window: must be one of …; client_id: must be a uuid" */
export function describeIssues(error: z.ZodError): string {
  return error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
}
