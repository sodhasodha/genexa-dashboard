// Turns queued reminders into Slack messages. Pure: no database, no network.
// What is due is decided in SQL (reminder_candidates); this only words it.
// Patients appear by first name only. Surnames, phones and emails never reach here.

/** One unsent notification, as reminders_deliverable returns it. */
export type Pending = {
  id: string;
  rule_key: string;
  staff_id: string | null;
  staff_name: string | null;
  slack_user_id: string | null;
  email: string | null;
  channel: string | null;
  record_type: string | null;
  record_id: string | null;
  window_key: string;
  template: string;
  payload: Record<string, unknown>;
};

export type Block = Record<string, unknown>;
export type Message = { text: string; blocks: Block[] };

/** Rules that go out together as one message at the start of a shift. */
export const SHIFT_START_RULES = ["start_of_shift_digest", "task_due_today", "task_overdue", "eod_missed"];

const ET = "America/New_York";
const MAX_ACTIONABLE = 12;
const MAX_LINES = 20;

type P = Record<string, unknown>;
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const list = (v: unknown): P[] => (Array.isArray(v) ? (v as P[]) : []);

/** Slack mrkdwn: the three characters that must be escaped. */
export const esc = (s: unknown) => str(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const link = (url: string, label: string) => `<${url}|${esc(label)}>`;
const money = (v: unknown) => {
  const n = num(v);
  return n === null ? "n/a" : `$${Math.round(n).toLocaleString("en-US")}`;
};
const count = (v: unknown) => {
  const n = num(v);
  return n === null ? "n/a" : String(Math.round(n * 10) / 10);
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Thu 08 Oct" for a YYYY-MM-DD date. */
export function day(date: unknown): string {
  const s = str(date).slice(0, 10);
  if (!s) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "short" }).format(new Date(`${s}T12:00:00Z`));
}
/** "Thu 08 Oct, 14:30 ET" for an instant. */
export function etTime(iso: unknown): string {
  const s = str(iso);
  if (!s) return "";
  return `${new Intl.DateTimeFormat("en-GB", { timeZone: ET, weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(s))} ET`;
}
/** 95 -> "1h 35m". */
export function duration(minutes: unknown): string {
  const m = Math.max(0, Math.round(num(minutes) ?? 0));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.round(m / 1440)}d`;
}
const colourDot = (c: unknown) => (c === "green" ? "🟢" : c === "amber" ? "🟠" : c === "red" ? "🔴" : "⚪");
const severityDot = (s: unknown) => (s === "red" ? "🔴" : "🟠");

const section = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } });

/** The Done / Snooze 1h pair. The value names the record the buttons act on. */
export function actions(recordType: "tasks" | "exceptions", id: string): Block {
  const value = `${recordType}:${id}`;
  return {
    type: "actions",
    block_id: `act:${value}`,
    elements: [
      { type: "button", action_id: "done", style: "primary", text: { type: "plain_text", text: "Done" }, value },
      { type: "button", action_id: "snooze_1h", text: { type: "plain_text", text: "Snooze 1h" }, value },
    ],
  };
}

/** Builds a message line by line; lines with buttons become their own blocks. */
class Draft {
  private blocks: Block[] = [];
  private lines: string[] = [];
  private buffer: string[] = [];
  private actionable = 0;
  private seen = new Set<string>();

  constructor(private readonly headline: string) {
    this.blocks.push(section(`*${esc(headline)}*`));
    this.lines.push(headline);
  }
  private flush() {
    if (this.buffer.length) this.blocks.push(section(this.buffer.join("\n")));
    this.buffer = [];
  }
  heading(text: string) {
    this.buffer.push(`*${esc(text)}*`);
    this.lines.push(text);
  }
  /** mrkdwn is the Slack text, plain the fallback. */
  line(mrkdwn: string, plain?: string) {
    this.buffer.push(mrkdwn);
    this.lines.push(plain ?? mrkdwn);
  }
  /** A capped bullet list. */
  bullets(items: string[], moreUrl?: string) {
    for (const item of items.slice(0, MAX_LINES)) this.line(`• ${item}`);
    if (items.length > MAX_LINES) this.line(`…and ${items.length - MAX_LINES} more${moreUrl ? ` · ${link(moreUrl, "see all")}` : ""}`);
  }
  /** A line with Done / Snooze 1h under it. */
  item(recordType: "tasks" | "exceptions", id: string, mrkdwn: string) {
    const key = `${recordType}:${id}`;
    if (this.seen.has(key) || this.actionable >= MAX_ACTIONABLE) {
      this.line(`• ${mrkdwn}`);
      return;
    }
    this.seen.add(key);
    this.actionable++;
    this.flush();
    this.blocks.push({ ...section(mrkdwn), block_id: `item:${key}` });
    this.blocks.push(actions(recordType, id));
    this.lines.push(mrkdwn);
  }
  done(): Message {
    this.flush();
    return { text: this.lines.join("\n").slice(0, 3000), blocks: this.blocks.slice(0, 50) };
  }
}

const taskLine = (t: P, appUrl: string, extra = "") =>
  `${link(`${appUrl}/tasks?task=${str(t.id)}`, str(t.title))}${t.client ? ` · ${esc(t.client)}` : ""}${extra}`;
const overdueBy = (t: P) => {
  const d = num(t.days_overdue);
  return d ? ` · ${plural(d, "day")} overdue` : "";
};
const exceptionLine = (e: P, id: string, appUrl: string) => {
  const m = num(e.money);
  return `${severityDot(e.severity)} ${esc(e.reason)}${m && m > 0 ? ` · ${money(m)} at risk` : ""} · ${link(`${appUrl}/overview?exception=${id}`, "open")}`;
};

/** The one message a person gets when their shift starts. */
function composeShiftStart(items: Pending[], appUrl: string): Message {
  const digest = items.find((i) => i.rule_key === "start_of_shift_digest");
  const d = new Draft(digest?.template ?? (items.find((i) => i.rule_key !== "task_assigned") ?? items[0]).template);
  const p = digest?.payload ?? {};

  // With the digest switched off, the task rules still list their own tasks.
  const due = digest ? list(p.tasks_due) : items.filter((i) => i.rule_key === "task_due_today").map((i) => ({ ...i.payload, id: i.record_id }));
  const overdue = digest ? list(p.tasks_overdue) : items.filter((i) => i.rule_key === "task_overdue").map((i) => ({ ...i.payload, id: i.record_id }));
  const eodMissing = digest ? p.eod_missing === true : items.some((i) => i.rule_key === "eod_missed");

  if (due.length) {
    d.heading("Due today");
    for (const t of due) d.item("tasks", str(t.id), taskLine(t, appUrl));
  }
  if (overdue.length) {
    d.heading("Overdue");
    for (const t of overdue) d.item("tasks", str(t.id), taskLine(t, appUrl, overdueBy(t)));
  }
  // Tasks assigned while the person was off shift ride along, unless already listed above.
  const listed = new Set([...due, ...overdue].map((t) => str(t.id)));
  const assigned = items.filter((i) => i.rule_key === "task_assigned" && !listed.has(str(i.record_id)));
  if (assigned.length) {
    d.heading("New tasks");
    for (const i of assigned) {
      const p = i.payload;
      d.item("tasks", str(i.record_id), taskLine({ ...p, id: i.record_id }, appUrl, `${p.assigned_by ? ` · from ${esc(p.assigned_by)}` : ""}${p.due ? ` · due ${day(p.due)}` : ""}`));
    }
  }
  const exceptions = list(p.exceptions);
  if (exceptions.length) {
    d.heading("Open exceptions");
    for (const e of exceptions) d.item("exceptions", str(e.id), exceptionLine(e, str(e.id), appUrl));
  }
  const deadlines = list(p.deadlines);
  if (deadlines.length) {
    d.heading("Next 48 hours");
    d.bullets(
      deadlines.map((x) =>
        x.kind === "tech_job"
          ? `${link(`${appUrl}/tech?job=${str(x.id)}`, str(x.title))}${x.client ? ` · ${esc(x.client)}` : ""} · due ${etTime(x.due_at)}`
          : `${link(`${appUrl}/tasks?task=${str(x.id)}`, str(x.title))} · due ${day(x.due)}`,
      ),
    );
  }
  if (eodMissing) d.line(`Yesterday's EOD is missing · ${link(`${appUrl}/eod`, "file it")}`);
  return d.done();
}

const scoreLine = (m: P) => {
  const fraction = num(m.denominator) ? ` (${count(m.numerator)} of ${count(m.denominator)})` : "";
  return `${colourDot(m.colour)} ${esc(str(m.metric).replace(/_/g, " "))}: ${count(m.value)}${fraction}`;
};

/** One message for all of one rule's reminders to one recipient. */
function composeRule(rule: string, items: Pending[], appUrl: string): Message {
  const d = new Draft(items[0].template);
  const first = items[0].payload;

  switch (rule) {
    case "ryan_morning_digest": {
      const p = first;
      d.line(`*${money(p.at_risk)} at risk* across ${plural(num(p.open_exceptions) ?? 0, "open exception")} · ${link(`${appUrl}/overview`, "overview")}`);
      const sections: [string, string[]][] = [
        ["Top bottlenecks", list(p.bottlenecks).map((b) => `${severityDot(b.severity)} ${esc(b.reason)}${num(b.money) ? ` · ${money(b.money)}` : ""}${b.owner ? ` · ${esc(b.owner)}` : ""} · ${link(`${appUrl}/overview?exception=${str(b.id)}`, "open")}`)],
        ["Renewals due in 7 days", list(p.renewals).map((r) => `${link(`${appUrl}/clients/${str(r.client_id)}`, str(r.client))} · ${money(r.amount)} · ${r.status === "overdue" ? `overdue since ${day(r.date)}` : `${day(r.date)}${r.status === "cancelling" ? " (cancelling)" : ""}`}`)],
        ["Guarantees due in 7 days", list(p.guarantees).map((g) => `${link(`${appUrl}/clients/${str(g.client_id)}`, str(g.client))} · ${money(g.revenue)} of ${money(g.target)} · ${day(g.deadline)}`)],
        ["Overdue prospect follow-ups", list(p.prospects).map((x) => `${link(`${appUrl}/pipeline?prospect=${str(x.id)}`, str(x.name))} · ${plural(num(x.days_overdue) ?? 0, "day")} overdue${x.promised ? ` · promised: ${esc(x.promised)}` : ""}`)],
        ["Missing EODs", list(p.missing_eods).map((e) => `${esc(e.name)} · ${day(e.day)}`)],
        ["Sync failures", list(p.stale_sources).map((s) => `${esc(s.source)} · last success ${etTime(s.last_success_at)}${s.error ? ` · ${esc(s.error)}` : ""}`)],
      ];
      // Only present when the attendance view exists.
      if (Array.isArray(p.attendance)) {
        sections.push(["Attendance this week", list(p.attendance).map((a) => `${esc(a.name)} · ${plural(num(a.late_count) ?? 0, "late")}, ${plural(num(a.no_show_count) ?? 0, "no-show")}`)]);
      }
      for (const [title, lines] of sections) {
        if (!lines.length) continue;
        d.heading(title);
        d.bullets(lines);
      }
      break;
    }
    case "eod_due":
      d.line(`${first.ended ? "Your shift has ended and today's EOD is not in." : "Your shift ends in 30 minutes. Your EOD is not in yet."} ${link(`${appUrl}/eod`, "File your EOD")}`);
      break;
    case "eod_missed":
      d.bullets(items.map((i) => `${esc(i.payload.name)} · ${day(i.payload.date)}`));
      d.line(link(`${appUrl}/eod`, "Open EODs"));
      break;
    case "task_due_today":
    case "task_overdue":
    case "task_assigned":
    case "task_snoozed":
      for (const i of items) {
        const p = i.payload;
        const bits = [
          p.assigned_by ? ` · from ${esc(p.assigned_by)}` : "",
          rule === "task_overdue" ? overdueBy(p) : p.due ? ` · due ${day(p.due)}` : "",
        ].join("");
        d.item("tasks", str(i.record_id), taskLine({ ...p, id: i.record_id }, appUrl, bits));
      }
      break;
    case "tech_job_new":
      d.bullets(items.map((i) => {
        const p = i.payload;
        return `${p.type === "fix" ? "🔴 " : ""}${esc(p.type)}: ${link(`${appUrl}/tech?job=${str(i.record_id)}`, str(p.title))}${p.client ? ` · ${esc(p.client)}` : ""}${p.due_at ? ` · due ${etTime(p.due_at)}` : ""}${p.requested_by ? ` · from ${esc(p.requested_by)}` : ""}`;
      }));
      break;
    case "tech_job_sla_warning":
      d.bullets(items.map((i) => {
        const p = i.payload;
        return `${link(`${appUrl}/tech?job=${str(i.record_id)}`, str(p.title))}${p.client ? ` · ${esc(p.client)}` : ""} · ${duration(p.minutes_left)}${p.business_minutes ? " of business time" : ""} left`;
      }));
      break;
    case "tech_job_sla_breached":
      d.bullets(items.map((i) => {
        const p = i.payload;
        return `🔴 ${link(`${appUrl}/tech?job=${str(i.record_id)}`, str(p.title))}${p.client ? ` · ${esc(p.client)}` : ""} · overdue by ${duration(p.minutes_over)}`;
      }));
      break;
    case "launch_sla_warning":
      d.bullets(items.map((i) => {
        const p = i.payload;
        const left = (p.qc_left as unknown[] | undefined) ?? [];
        return `${link(`${appUrl}/launches?launch=${str(i.record_id)}`, str(p.client))} · ${count(p.hours_left)}h left of 48h · stage: ${esc(str(p.stage).replace(/_/g, " "))} · QC left: ${left.length ? esc(left.join(", ")) : "nothing"}`;
      }));
      break;
    case "exception_opened":
      for (const i of items) d.item("exceptions", str(i.record_id), exceptionLine(i.payload, str(i.record_id), appUrl));
      break;
    case "owner_escalation":
      d.bullets(items.map((i) => {
        const p = i.payload;
        const url = p.kind === "tasks" ? `${appUrl}/tasks?task=${str(i.record_id)}` : p.kind === "tech_jobs" ? `${appUrl}/tech?job=${str(i.record_id)}` : `${appUrl}/overview?exception=${str(i.record_id)}`;
        return `${link(url, str(p.title))} · ${esc(p.owner)} reminded ${plural(num(p.times) ?? 0, "time")}, first ${etTime(p.first_sent)}`;
      }));
      break;
    case "unconfirmed_tomorrow": {
      d.line(`${plural(num(first.count) ?? 0, "consult")} not confirmed for ${day(first.date)}`);
      for (const c of list(first.clinics)) {
        d.heading(`${str(c.client)} (${count(c.count)})`);
        d.bullets(list(c.consults).map((a) => `${esc(a.first_name) || "No name"} · ${etTime(a.at)}`));
      }
      d.line(link(`${appUrl}/call-centre`, "Open call centre"));
      break;
    }
    case "outcome_overdue":
      d.bullets(items.map((i) => `${esc(i.payload.client)} · ${esc(i.payload.first_name) || "No name"} · consult ${etTime(i.payload.at)}`));
      d.line(link(`${appUrl}/data-review?queue=unlogged_outcome`, "Log the outcome"));
      break;
    case "renewal_due":
      d.bullets(items.map((i) => {
        const p = i.payload;
        const n = num(p.days_until) ?? 0;
        const when = p.status === "overdue" ? `overdue since ${day(p.renewal_date)}` : `in ${plural(n, "day")} (${day(p.renewal_date)})`;
        return `${link(`${appUrl}/clients/${str(i.record_id)}`, str(p.client))} · ${money(p.amount)} · ${when}${p.status === "cancelling" ? " · cancelling" : ""}\n   This month: spend ${money(p.spend)}, booked ${count(p.booked)}, shows ${count(p.shows)}, closes ${count(p.closes)}`;
      }));
      break;
    case "guarantee_deadline":
      d.bullets(items.map((i) => {
        const p = i.payload;
        return `${link(`${appUrl}/clients/${str(i.record_id)}`, str(p.client))} · ${plural(num(p.days_until) ?? 0, "day")} left (${day(p.deadline)}) · target ${money(p.target)} · revenue since launch ${money(p.revenue)} · gap ${money(p.gap)}`;
      }));
      break;
    case "prospect_follow_up":
      d.bullets(items.map((i) => {
        const p = i.payload;
        const late = num(p.days_overdue) ?? 0;
        return `${link(`${appUrl}/pipeline?prospect=${str(i.record_id)}`, str(p.name))} · ${late > 0 ? `${plural(late, "day")} overdue` : "today"}${p.promised ? ` · promised: ${esc(p.promised)}` : ""}`;
      }));
      break;
    case "sync_failure":
      d.bullets(items.map((i) => `${esc(i.payload.source)} · last success ${etTime(i.payload.last_success_at)}${i.payload.error ? ` · ${esc(i.payload.error)}` : ""}`));
      d.line(link(`${appUrl}/integrations`, "Open integrations"));
      break;
    case "weekly_scorecard":
      d.line(`Week of ${day(first.week_start)} · ${link(`${appUrl}/team`, "open scorecards")}`);
      for (const i of items) {
        for (const person of list(i.payload.people)) {
          if (i.payload.everyone) d.heading(str(person.name));
          d.bullets(list(person.metrics).map(scoreLine));
        }
      }
      break;
    default:
      // A rule with no wording yet still says which record it is about.
      d.line(link(`${appUrl}/overview`, "Open Genexa OS"));
  }
  return d.done();
}

export type Group = { target: string; isChannel: boolean; items: Pending[]; message: Message };

/**
 * Groups what is ready into Slack messages: per recipient, one message for the
 * start-of-shift rules together and one per other rule.
 */
export function composeAll(items: Pending[], appUrl: string): Group[] {
  const buckets = new Map<string, Pending[]>();
  // The owner's copy of someone else's missed EOD is its own message, not part of the owner's shift start.
  const isShiftStart = (i: Pending) => SHIFT_START_RULES.includes(i.rule_key) && (i.rule_key !== "eod_missed" || i.record_id === i.staff_id);
  const startingShift = new Set(items.filter(isShiftStart).map((i) => i.staff_id));
  for (const item of items) {
    const recipient = item.staff_id ?? `channel:${item.channel}`;
    // A task assigned overnight joins the shift-start message, so the person gets one DM, not two.
    const ownShiftStart = isShiftStart(item) || (item.rule_key === "task_assigned" && startingShift.has(item.staff_id));
    const key = `${recipient}|${ownShiftStart ? "shift_start" : item.rule_key}`;
    buckets.set(key, [...(buckets.get(key) ?? []), item]);
  }
  const groups: Group[] = [];
  for (const [key, bucket] of buckets) {
    const first = bucket[0];
    const message = key.endsWith("|shift_start") ? composeShiftStart(bucket, appUrl) : composeRule(first.rule_key, bucket, appUrl);
    groups.push({ target: first.staff_id ?? first.channel ?? "", isChannel: !first.staff_id, items: bucket, message });
  }
  return groups;
}
