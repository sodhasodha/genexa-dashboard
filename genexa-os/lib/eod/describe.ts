import { BLOCKER_LABEL, readAnswers, type EodAnswers } from "./schema";

/** id -> display name, for the clients, exceptions and tech jobs an EOD points at. */
export type Names = ReadonlyMap<string, string>;
export type EodLine = { label: string; value: string };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s: string, max = 60) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const named = (ids: string[], names: Names) => ids.map((id) => names.get(id) ?? "(no longer listed)").join(", ");
const blockerText = (blocker: string, other: string | null) =>
  blocker === "other" && other ? `Other: ${other}` : (BLOCKER_LABEL[blocker] ?? blocker);

const OLD_FORMAT = "Filed before the current form (answers in an older format)";

/** One line for a list of EODs. */
export function summariseEod(role: string, raw: unknown): string {
  const eod = readAnswers(role, raw);
  if (!eod) return OLD_FORMAT;
  return summarise(eod);
}

function summarise(eod: EodAnswers): string {
  if (eod.role === "csr") {
    const a = eod.answers;
    return [
      `${a.hours_worked}h`,
      a.blocker === "none" ? "no blocker" : `blocker: ${clip(blockerText(a.blocker, a.blocker_other), 40).toLowerCase()}`,
      `focus ${a.focus}/5`,
      a.patient_flag ? "patient flagged" : null,
    ].filter(Boolean).join(" · ");
  }
  if (eod.role === "media_buyer") {
    const a = eod.answers;
    const tests = a.tests.reduce((n, t) => n + t.count, 0);
    return [
      `${plural(a.accounts_touched.length, "account")} touched`,
      `${plural(a.exceptions_cleared.length, "exception")} cleared`,
      `${plural(tests, "test")} launched`,
      a.creative_by ? `creative needed by ${a.creative_by}` : null,
    ].filter(Boolean).join(" · ");
  }
  const a = eod.answers;
  return [
    `${plural(a.jobs_shipped.length, "job")} shipped`,
    a.blocked_on ? `blocked: ${clip(a.blocked_on, 40)}` : null,
    a.broke_after_live ? "something broke after going live" : null,
    `tomorrow: ${clip(a.tomorrow_first, 40)}`,
  ].filter(Boolean).join(" · ");
}

/** Every answer as a label and a value, for reading one EOD in full. */
export function describeEod(role: string, raw: unknown, names: Names): EodLine[] {
  const eod = readAnswers(role, raw);
  if (!eod) return [{ label: "Answers", value: OLD_FORMAT }];
  const none = "—";
  if (eod.role === "csr") {
    const a = eod.answers;
    return [
      { label: "Hours worked", value: String(a.hours_worked) },
      { label: "Biggest blocker", value: blockerText(a.blocker, a.blocker_other) },
      { label: "Patient worth flagging", value: a.patient_flag ?? none },
      { label: "Focus", value: `${a.focus} of 5` },
    ];
  }
  if (eod.role === "media_buyer") {
    const a = eod.answers;
    return [
      { label: "Accounts touched", value: a.accounts_touched.length ? named(a.accounts_touched, names) : none },
      { label: "What changed", value: a.what_changed ?? none },
      { label: "Exceptions cleared", value: a.exceptions_cleared.length ? named(a.exceptions_cleared, names) : none },
      {
        label: "Tests launched",
        value: a.tests.length ? a.tests.map((t) => `${names.get(t.client_id) ?? "(no longer listed)"} × ${t.count}`).join(", ") : none,
      },
      {
        label: "Creative needed",
        value: a.creative_needed ? `${a.creative_needed} · from ${a.creative_from} · by ${a.creative_by}` : none,
      },
      { label: "Call-centre note", value: a.call_centre_note ?? none },
    ];
  }
  const a = eod.answers;
  return [
    { label: "Jobs shipped", value: a.jobs_shipped.length ? named(a.jobs_shipped, names) : none },
    { label: "Blocked on", value: a.blocked_on ?? none },
    { label: "Broke after going live", value: a.broke_after_live ?? none },
    { label: "First thing tomorrow", value: a.tomorrow_first },
  ];
}

/** Every client, exception and tech job id an EOD points at. */
export function referencedIds(role: string, raw: unknown): { clients: string[]; exceptions: string[]; jobs: string[] } {
  const eod = readAnswers(role, raw);
  if (eod?.role === "media_buyer") {
    const a = eod.answers;
    return { clients: [...a.accounts_touched, ...a.tests.map((t) => t.client_id)], exceptions: a.exceptions_cleared, jobs: [] };
  }
  if (eod?.role === "tech") return { clients: [], exceptions: [], jobs: eod.answers.jobs_shipped };
  return { clients: [], exceptions: [], jobs: [] };
}
