import { z } from "zod";

/**
 * What is stored in eods.answers, one flat object per role. `v` is the shape version.
 * Answers are context for the reader. Nothing here is a score: people are scored on
 * system timestamps only, so no form asks for counts of bookings, calls or confirmations.
 *
 * csr
 *   { v: 1,
 *     hours_worked: number,            // 0-24
 *     blocker: "none" | "dialer" | "no_pickups" | "clinic_info_missing" | "junk_leads" | "other",
 *     blocker_other: string | null,    // set only when blocker = "other"
 *     patient_flag: string | null,     // free text, first name only
 *     focus: 1 | 2 | 3 | 4 | 5 }
 *
 * media_buyer
 *   { v: 1,
 *     accounts_touched: uuid[],        // clients.id
 *     what_changed: string | null,     // required when accounts_touched is not empty
 *     exceptions_cleared: uuid[],      // exceptions.id
 *     tests: { client_id: uuid, count: number }[],   // up to 5 rows, count 1-50
 *     creative_needed: string | null,  // these three are all set or all null
 *     creative_from: string | null,
 *     creative_by: "YYYY-MM-DD" | null,
 *     call_centre_note: string | null }
 *
 * tech
 *   { v: 1,
 *     jobs_shipped: uuid[],            // tech_jobs.id
 *     blocked_on: string | null,
 *     broke_after_live: string | null,
 *     tomorrow_first: string }
 */

export const EOD_ROLES = ["csr", "media_buyer", "tech"] as const;
export type EodRole = (typeof EOD_ROLES)[number];
export const isEodRole = (role: string): role is EodRole => (EOD_ROLES as readonly string[]).includes(role);

export const CSR_BLOCKERS = [
  { value: "none", label: "Nothing blocked me" },
  { value: "dialer", label: "Dialer" },
  { value: "no_pickups", label: "No pickups" },
  { value: "clinic_info_missing", label: "Clinic info missing" },
  { value: "junk_leads", label: "Junk leads" },
  { value: "other", label: "Other" },
] as const;
export const BLOCKER_LABEL: Record<string, string> = Object.fromEntries(CSR_BLOCKERS.map((b) => [b.value, b.label]));

export const MAX_TESTS = 5;
const SHORT = 200;
const LONG = 1000;
const optional = (max: number) => z.string().min(1).max(max).nullable();

export const CsrAnswers = z
  .object({
    v: z.literal(1),
    hours_worked: z.number().min(0).max(24),
    blocker: z.enum(CSR_BLOCKERS.map((b) => b.value)),
    blocker_other: optional(SHORT),
    patient_flag: optional(SHORT),
    focus: z.number().int().min(1).max(5),
  })
  .refine((a) => a.blocker !== "other" || a.blocker_other !== null, { path: ["blocker_other"] });

export const MediaBuyerAnswers = z
  .object({
    v: z.literal(1),
    accounts_touched: z.array(z.uuid()).max(100),
    what_changed: optional(LONG),
    exceptions_cleared: z.array(z.uuid()).max(100),
    tests: z.array(z.object({ client_id: z.uuid(), count: z.number().int().min(1).max(50) })).max(MAX_TESTS),
    creative_needed: optional(SHORT),
    creative_from: optional(SHORT),
    creative_by: z.iso.date().nullable(),
    call_centre_note: optional(LONG),
  })
  .refine((a) => a.accounts_touched.length === 0 || a.what_changed !== null, { path: ["what_changed"] })
  .refine(
    (a) => new Set([a.creative_needed === null, a.creative_from === null, a.creative_by === null]).size === 1,
    { path: ["creative_needed"] },
  );

export const TechAnswers = z.object({
  v: z.literal(1),
  jobs_shipped: z.array(z.uuid()).max(100),
  blocked_on: optional(LONG),
  broke_after_live: optional(LONG),
  tomorrow_first: z.string().min(1).max(SHORT),
});

export type CsrAnswers = z.infer<typeof CsrAnswers>;
export type MediaBuyerAnswers = z.infer<typeof MediaBuyerAnswers>;
export type TechAnswers = z.infer<typeof TechAnswers>;
export type EodAnswers =
  | { role: "csr"; answers: CsrAnswers }
  | { role: "media_buyer"; answers: MediaBuyerAnswers }
  | { role: "tech"; answers: TechAnswers };

/** Stored answers read back as the role's shape, or null when they are not in it. */
export function readAnswers(role: string, raw: unknown): EodAnswers | null {
  if (role === "csr") {
    const r = CsrAnswers.safeParse(raw);
    return r.success ? { role, answers: r.data } : null;
  }
  if (role === "media_buyer") {
    const r = MediaBuyerAnswers.safeParse(raw);
    return r.success ? { role, answers: r.data } : null;
  }
  if (role === "tech") {
    const r = TechAnswers.safeParse(raw);
    return r.success ? { role, answers: r.data } : null;
  }
  return null;
}

/** Plain-English messages for every way saving can fail. */
export const EOD_ERRORS: Record<string, string> = {
  invalid: "Something in the form was not filled in correctly. Check it and save again.",
  hours: "Enter the hours you worked today as a number between 0 and 24.",
  blocker: "Choose your biggest blocker today.",
  blocker_other: "You chose Other as your blocker. Say what it was in a few words.",
  focus: "Choose your focus from 1 to 5.",
  what_changed: "You ticked accounts you touched. Say what you changed.",
  tests: "Each test row needs a clinic and a count between 1 and 50.",
  creative: "Fill in all three creative fields (what, from whom, by when), or leave all three blank.",
  tomorrow: "Say what you will do first tomorrow.",
  too_long: "One of your answers is too long. Shorten it and save again.",
  options: "Something you ticked is no longer on your list. The form has been reloaded, tick again and save.",
  no_form: "There is no EOD form for your role.",
  closed: "That day has ended in your timezone, so its EOD can no longer be filed or changed. The form below is for today.",
  own: "You can only file your own EOD.",
  save: "The EOD could not be saved. Try again.",
};

const FIELD_ERROR: Record<string, string> = {
  hours_worked: "hours",
  blocker: "blocker",
  blocker_other: "blocker_other",
  focus: "focus",
  what_changed: "what_changed",
  tests: "tests",
  creative_needed: "creative",
  creative_from: "creative",
  creative_by: "creative",
  tomorrow_first: "tomorrow",
};

/** The message code for a database error raised by the eods_rules trigger or RLS. */
export function eodDbErrorCode(message: string): string {
  if (message.includes("EOD_CLOSED")) return "closed";
  if (message.includes("EOD_OWN") || message.includes("row-level security")) return "own";
  return "save";
}

export type ParsedEod = { ok: true; value: EodAnswers } | { ok: false; error: string };

/** Turn a submitted form into the role's stored shape. Blank text becomes null. */
export function parseEodForm(role: EodRole, form: FormData): ParsedEod {
  const text = (name: string) => {
    const v = form.get(name);
    const s = typeof v === "string" ? v.trim() : "";
    return s === "" ? null : s;
  };
  const number = (v: string | null) => (v === null || Number.isNaN(Number(v)) ? undefined : Number(v));
  const ids = (name: string) => [...new Set(form.getAll(name).map(String).filter((v) => v !== ""))];

  const fail = (error: z.ZodError): ParsedEod => {
    const issue = error.issues[0];
    if (issue.code === "too_big" && issue.origin === "string") return { ok: false, error: "too_long" };
    return { ok: false, error: FIELD_ERROR[String(issue.path[0])] ?? "invalid" };
  };

  if (role === "csr") {
    const blocker = text("blocker");
    const r = CsrAnswers.safeParse({
      v: 1,
      hours_worked: number(text("hours_worked")),
      blocker,
      blocker_other: blocker === "other" ? text("blocker_other") : null,
      patient_flag: text("patient_flag"),
      focus: number(text("focus")),
    });
    return r.success ? { ok: true, value: { role, answers: r.data } } : fail(r.error);
  }

  if (role === "media_buyer") {
    // A test row counts only when a clinic is picked; the count box has a default of 1.
    const testClients = form.getAll("test_client").map(String);
    const testCounts = form.getAll("test_count").map(String);
    const tests = testClients
      .map((client_id, i) => ({ client_id, count: number(testCounts[i]?.trim() || null) }))
      .filter((t) => t.client_id !== "");
    const r = MediaBuyerAnswers.safeParse({
      v: 1,
      accounts_touched: ids("accounts_touched"),
      what_changed: text("what_changed"),
      exceptions_cleared: ids("exceptions_cleared"),
      tests,
      creative_needed: text("creative_needed"),
      creative_from: text("creative_from"),
      creative_by: text("creative_by"),
      call_centre_note: text("call_centre_note"),
    });
    return r.success ? { ok: true, value: { role, answers: r.data } } : fail(r.error);
  }

  const r = TechAnswers.safeParse({
    v: 1,
    jobs_shipped: ids("jobs_shipped"),
    blocked_on: text("blocked_on"),
    broke_after_live: text("broke_after_live"),
    tomorrow_first: text("tomorrow_first") ?? "",
  });
  return r.success ? { ok: true, value: { role, answers: r.data } } : fail(r.error);
}
