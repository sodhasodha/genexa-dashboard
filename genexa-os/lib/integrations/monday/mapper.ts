// Typed mappers for the one-off monday.com import. Pure functions: no I/O.
// Shapes come from real responses saved under fixtures/monday/raw (git-ignored:
// they hold pay and contact details). tests/unit/monday-mapper.test.ts runs
// these against a redacted copy with the same structure.

export type MondayColumnValue = { id: string; text: string | null; value: string | null; type: string };
export type MondayItem = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  group: { id: string; title: string };
  column_values: MondayColumnValue[];
};
export type MondayBoard = {
  id: string;
  name: string;
  columns: { id: string; title: string; type: string }[];
  items_page: { cursor: string | null; items: MondayItem[] };
};

/** Read an item's columns by title rather than Monday's opaque column ids. */
export function byTitle(board: MondayBoard, item: MondayItem) {
  const idByTitle = new Map(board.columns.map((c) => [c.title, c.id]));
  const valueById = new Map(item.column_values.map((v) => [v.id, v]));
  const col = (title: string) => {
    const id = idByTitle.get(title);
    if (!id) throw new Error(`Monday board "${board.name}" has no column "${title}"`);
    return valueById.get(id);
  };
  const text = (title: string): string | null => {
    const t = col(title)?.text;
    return t === null || t === undefined || t.trim() === "" ? null : t.trim();
  };
  return {
    text,
    number: (title: string): number | null => {
      const t = text(title);
      if (t === null) return null;
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    },
    date: (title: string): string | null => {
      const t = text(title);
      return t && /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
    },
    /** Link columns show "label - url" as text; the URL itself is in the JSON value. */
    url: (title: string): string | null => {
      const raw = col(title)?.value;
      if (!raw) return null;
      try {
        const u = (JSON.parse(raw) as { url?: string }).url;
        return u && u.trim() !== "" ? u.trim() : null;
      } catch {
        return null;
      }
    },
  };
}

const POD_SUFFIX = /\s+pod\s*\d+\s*$/i;
export const cleanClientName = (name: string) => name.replace(POD_SUFFIX, "").trim();

const podFromGroup = (title: string): "pod_1" | "pod_2" | "pod_3" | null => {
  const m = /^pod\s*([123])\b/i.exec(title.trim());
  return m ? (`pod_${m[1]}` as "pod_1" | "pod_2" | "pod_3") : null;
};

/** A date-only Monday value as a timestamp that falls on the same day in ET. */
const dateAsTimestamp = (d: string | null) => (d ? `${d}T16:00:00Z` : null);

const STAGE: Record<string, string> = { Live: "live", Onboarding: "onboarding", Unlaunched: "unlaunched", Churned: "churned" };
const CYCLE: Record<string, string> = { "30 days": "30", "90 days": "90", Legacy: "legacy" };

export type Unmapped = { board: string; item: string; problem: string };

export function mapClient(board: MondayBoard, item: MondayItem, unmapped: Unmapped[]) {
  const c = byTitle(board, item);
  const note = (problem: string) => unmapped.push({ board: board.name, item: item.name, problem });

  const stageText = c.text("Stage");
  let stage = stageText ? STAGE[stageText] : undefined;
  if (/churned/i.test(item.group.title)) stage = "churned";
  if (!stage) {
    note(`Stage "${stageText ?? ""}" not recognised; set to unlaunched`);
    stage = "unlaunched";
  }
  const cycleText = c.text("Billing Cycle");
  const billing_cycle = cycleText ? (CYCLE[cycleText] ?? null) : null;
  if (cycleText && !billing_cycle) note(`Billing Cycle "${cycleText}" not recognised`);
  if (!cycleText && stage !== "churned") note("No Billing Cycle: no renewal date can be computed");
  const monthly_fee = c.number("Monthly Fee ($)");
  if (monthly_fee === null && stage !== "churned") note("No Monthly Fee: excluded from MRR until set");
  const launch_date = c.date("Launch Date");
  if (!launch_date && stage === "live") note("Live with no Launch Date: renewals and days live show no data");

  const guarantee_text = c.text("Guarantee");
  const amount = guarantee_text ? /\$\s?([\d,]+(?:\.\d+)?)/.exec(guarantee_text) : null;

  return {
    legacy_ref: item.id,
    name: cleanClientName(item.name),
    contact_name: c.text("Full Name"),
    stage,
    pod: podFromGroup(item.group.title),
    billing_cycle,
    monthly_fee,
    launch_date,
    guarantee_text,
    guarantee_target_amount: amount ? Number(amount[1].replace(/,/g, "")) : null,
    guarantee_deadline: c.date("Guarantee Deadline"),
    next_action: c.text("Next Action"),
    last_contact_us: dateAsTimestamp(c.date("Last Contact (Us)")),
    last_reply_client: dateAsTimestamp(c.date("Last Reply (Client)")),
    legacy_last_payment_date: c.date("Last Payment"),
    legacy_total_paid: c.number("Total Paid ($)"),
    onboarding_status: c.text("Status"),
    ob_form_status: c.text("OB Form"),
    ob_call_date: c.date("OB Call Date"),
    contract_status: c.text("Contract"),
    billing_notes: c.text("Billing"),
    kickoff_url: c.url("Kickoff"),
    drive_url: c.url("Drive"),
    closer_notes: c.text("Closer Notes"),
    fathom_url: c.url("Fathom"),
    slack_general_id: c.text("General Slack ID"),
    slack_scheduling_id: c.text("Scheduling Slack ID"),
    churn_date: null as string | null,
  };
}

const ROLE: Record<string, { role: string; also_role: string | null }> = {
  CSR: { role: "csr", also_role: null },
  Tech: { role: "tech", also_role: null },
  "Fulfilment lead": { role: "media_buyer", also_role: "call_centre_manager" },
};
const STAFF_STATUS: Record<string, string> = { Active: "active", Trial: "trial", "At risk": "at_risk", Left: "left", Former: "left" };
export const isPlaceholderStaff = (name: string) => /^csr hire\s*\d*$/i.test(name.trim());

export function mapStaff(board: MondayBoard, item: MondayItem, unmapped: Unmapped[]) {
  if (isPlaceholderStaff(item.name)) return null;
  const c = byTitle(board, item);
  const roleText = c.text("Role");
  const role = roleText ? ROLE[roleText] : undefined;
  if (!role) {
    unmapped.push({ board: board.name, item: item.name, problem: `Role "${roleText ?? ""}" not recognised; row skipped` });
    return null;
  }
  const statusText = c.text("Status");
  const former = /former/i.test(item.group.title);
  return {
    staff: {
      legacy_ref: item.id,
      name: item.name.trim(),
      role: role.role,
      also_role: role.also_role,
      pod: podFromGroup(item.group.title),
      status: former ? "left" : ((statusText && STAFF_STATUS[statusText]) ?? "active"),
      start_date: c.date("Start Date"),
    },
    pay: {
      hourly_rate: c.number("Hourly Rate ($)"),
      hours_week: c.number("Hours / Week"),
      weekly_pay: c.number("Weekly Pay ($)"),
      payment_method: c.text("Payment Method"),
    },
  };
}

const TASK_GROUP: Record<string, string> = { Today: "today", "This Week": "week", Later: "later", Done: "done" };
const PRIORITY: Record<string, string> = { High: "high", Medium: "medium", Low: "low" };
const SOURCE: Record<string, string> = { Me: "ryan", Ryan: "ryan", Claude: "claude", Slack: "slack", Pushpin: "pushpin", Call: "call" };
const TASK_STATUS: Record<string, string> = { "To do": "todo", "To Do": "todo", Doing: "doing", "Working on it": "doing", Stuck: "stuck", Done: "done" };

const isBlankName = (name: string) => name.trim() === "" || /^(task|new task|item|new item)$/i.test(name.trim());

/** Coaching, consult-confirmation and CSR items are call centre; everything else on Aditya's list is ads. */
export function adityaCategory(title: string): "ads" | "call_centre" {
  return /\b(coach|consults?|confirm\w*|eods?|call attempts?|csr|pod \d|rotate all numbers|dialer)\b/i.test(title)
    ? "call_centre"
    : "ads";
}

export type TaskRow = {
  legacy_ref: string;
  title: string;
  category: string;
  priority: string;
  due: string | null;
  status: string;
  task_group: string;
  source: string;
  notes: string | null;
  done_at: string | null;
  created_at: string;
  client_text: string | null;
};

export function mapTask(board: MondayBoard, item: MondayItem, owner: "ryan" | "aditya", unmapped: Unmapped[]): TaskRow | null {
  if (isBlankName(item.name)) return null;
  const c = byTitle(board, item);
  const group = TASK_GROUP[item.group.title];
  if (!group) {
    unmapped.push({ board: board.name, item: item.name, problem: `Group "${item.group.title}" not recognised; row skipped` });
    return null;
  }
  const statusText = owner === "aditya" ? c.text("Status") : null;
  const done = group === "done" || statusText === "Done";
  const sourceText = c.text("Source");
  const source = sourceText ? SOURCE[sourceText] : "ryan";
  if (!source) {
    unmapped.push({ board: board.name, item: item.name, problem: `Source "${sourceText}" not recognised; row skipped` });
    return null;
  }
  return {
    legacy_ref: item.id,
    title: item.name.trim(),
    category: owner === "aditya" ? adityaCategory(item.name) : "general",
    priority: PRIORITY[c.text("Priority") ?? ""] ?? "medium",
    due: c.date("Due"),
    status: done ? "done" : ((statusText && TASK_STATUS[statusText]) ?? "todo"),
    task_group: done ? "done" : group,
    source,
    notes: c.text("Notes"),
    done_at: done ? item.updated_at : null,
    created_at: item.created_at,
    client_text: owner === "aditya" ? c.text("Client") : null,
  };
}

/** The one Aditya item that is two people's work: ads stay with Aditya, the launch goes to tech. */
export const isVitaleSplitItem = (name: string) => /^vitale \^ new location \+ ad account launch/i.test(name.trim());

const JOB_STATUS: Record<string, string> = { "To Do": "todo", "Working on it": "working", Working: "working", Stuck: "stuck", Done: "done" };
const JOB_TYPE: Record<string, string> = { Launch: "launch", Fix: "fix", Build: "build", Other: "other" };

export function mapTechJob(board: MondayBoard, item: MondayItem, unmapped: Unmapped[]) {
  if (isBlankName(item.name)) return null;
  const c = byTitle(board, item);
  const typeText = c.text("Type");
  let type = typeText ? JOB_TYPE[typeText] : undefined;
  if (!type) {
    type = /^launch\b/i.test(item.name.trim()) ? "launch" : "other";
    unmapped.push({ board: board.name, item: item.name, problem: `No Type on Monday; set to "${type}" from the title` });
  }
  const statusText = c.text("Status");
  const done = /done/i.test(item.group.title) || statusText === "Done";
  return {
    legacy_ref: item.id,
    title: item.name.trim(),
    type,
    // The original creation time, so an old request shows as overdue.
    requested_at: item.created_at,
    status: done ? "done" : ((statusText && JOB_STATUS[statusText]) ?? "todo"),
    done_at: done ? (c.date("Completed") ? `${c.date("Completed")}T16:00:00Z` : item.updated_at) : null,
    client_text: c.text("Clinic"),
  };
}

const PROSPECT_STAGE = (group: string): string | null =>
  /^chase/i.test(group) ? "chase" : /^contract out/i.test(group) ? "contract_out" : /^paid/i.test(group) ? "paid" : /^dead/i.test(group) ? "dead" : null;

export function mapProspect(board: MondayBoard, item: MondayItem, unmapped: Unmapped[]) {
  if (isBlankName(item.name)) return null;
  const stage = PROSPECT_STAGE(item.group.title);
  if (!stage) {
    unmapped.push({ board: board.name, item: item.name, problem: `Group "${item.group.title}" not recognised; row skipped` });
    return null;
  }
  const c = byTitle(board, item);
  const heat = c.text("Heat")?.toLowerCase() ?? null;
  return {
    legacy_ref: item.id,
    name: item.name.trim(),
    contact: c.text("Contact"),
    state: c.text("State"),
    heat: heat && ["hot", "warm", "cold"].includes(heat) ? heat : null,
    call_date: c.date("Call Date"),
    what_they_want: c.text("What They Want"),
    objection: c.text("Objection"),
    promised: c.text("What Ryan Promised"),
    follow_up_date: c.date("Follow-up Date"),
    fathom_url: c.url("Fathom"),
    deal_size: c.number("Deal Size ($)"),
    stage,
  };
}

export type MondayActivity = { id: string; event: string; created_at: string; data: string };

/** Deleted item names from a board's activity log. Monday timestamps are unix time x 10^7. */
export function mapDeletedItems(logs: MondayActivity[]) {
  const out: { legacy_ref: string; title: string; deleted_at: string }[] = [];
  for (const log of logs) {
    if (log.event !== "delete_pulse") continue;
    const data = JSON.parse(log.data) as { pulse_id?: number | string; pulse_name?: string };
    if (!data.pulse_name || data.pulse_name.trim() === "" || data.pulse_id === undefined) continue;
    out.push({
      legacy_ref: String(data.pulse_id),
      title: data.pulse_name.trim(),
      deleted_at: new Date(Number(log.created_at) / 10_000).toISOString(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Name matching
// ---------------------------------------------------------------------------
const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t !== "" && !["llc", "inc", "the", "and", "pod"].includes(t));

/**
 * The single client a free-text reference points to, or null when it matches
 * none or more than one. Matches on the clinic name or the contact's name.
 */
export function matchClient<T extends { name: string; contact_name: string | null }>(text: string | null, clients: T[]): T | null {
  if (!text) return null;
  const want = tokens(text);
  if (want.length === 0) return null;
  const hits = clients.filter((c) => {
    const have = new Set([...tokens(c.name), ...tokens(c.contact_name ?? "")]);
    return want.every((t) => have.has(t));
  });
  return hits.length === 1 ? hits[0] : null;
}

export type CortanaMatch = { business_id: string; business_name: string; confidence: "exact" | "likely" } | null;
export type CortanaCandidate = { business_id: string; business_name: string; shared: string[] };

/**
 * Match a clinic to a Cortana business by name.
 * exact  = same words once company suffixes are removed.
 * likely = one side's words are all contained in the other's, and no other business fits.
 * Anything weaker is returned as a candidate only and the id is left blank.
 */
export function matchCortanaBusiness(
  clientName: string,
  businesses: { id: string; name: string }[],
): { match: CortanaMatch; candidates: CortanaCandidate[] } {
  const want = tokens(clientName);
  const wantSet = new Set(want);
  const scored = businesses.map((b) => {
    const have = tokens(b.name);
    const haveSet = new Set(have);
    const shared = want.filter((t) => haveSet.has(t));
    const exact = want.length === have.length && shared.length === want.length;
    const subset = shared.length >= 2 && (want.every((t) => haveSet.has(t)) || have.every((t) => wantSet.has(t)));
    const single = want.length === 1 && have.length === 1 && shared.length === 1;
    return { b, shared, exact: exact || single, subset };
  });
  const exact = scored.filter((s) => s.exact);
  if (exact.length === 1) {
    return { match: { business_id: exact[0].b.id, business_name: exact[0].b.name, confidence: "exact" }, candidates: [] };
  }
  const likely = scored.filter((s) => s.subset);
  if (exact.length === 0 && likely.length === 1) {
    return { match: { business_id: likely[0].b.id, business_name: likely[0].b.name, confidence: "likely" }, candidates: [] };
  }
  const generic = new Set(["dr", "md", "health", "medical", "clinic", "wellness", "center", "pain", "stem", "cells", "iv"]);
  const candidates = scored
    .filter((s) => s.shared.some((t) => !generic.has(t)))
    .map((s) => ({ business_id: s.b.id, business_name: s.b.name, shared: s.shared }));
  return { match: null, candidates };
}
