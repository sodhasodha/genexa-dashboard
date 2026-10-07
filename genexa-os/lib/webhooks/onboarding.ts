// POST /api/webhooks/onboarding, without Next or the database: the route hands
// in the secret and the function that calls onboarding_intake.
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// Forms send "" or null for a blank optional field: treat both as absent.
const blank = (v: unknown) => (v === "" || v === null ? undefined : v);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blank, schema.optional());
const isoDateTime = z.iso.datetime({ offset: true, error: "must be an ISO date-time with a timezone, e.g. 2026-10-07T14:30:00Z" });
const httpUrl = z.url({ protocol: /^https?$/, error: "must be an http(s) URL" });

export const onboardingBody = z.strictObject({
  event_id: z.string().trim().min(1, "is required").max(200),
  clinic_name: z.string().trim().min(1, "is required").max(200),
  contact_name: optional(z.string().trim().max(200)),
  contact_email: optional(z.email("must be an email address")),
  billing_cycle: optional(z.enum(["30", "90"])),
  cycle_fee: optional(z.number().positive().max(1_000_000)),
  paid_at: optional(isoDateTime),
  ob_form_done_at: optional(isoDateTime),
  kickoff_url: optional(httpUrl),
  drive_url: optional(httpUrl),
  pod: optional(z.enum(["pod_1", "pod_2", "pod_3"])),
});
export type OnboardingBody = z.infer<typeof onboardingBody>;

/** What onboarding_intake returns. */
export type IntakeResult =
  | { duplicate: true }
  | { duplicate: false; client_id: string; client_created: boolean; launch_id: string; launch_created: boolean; message: string };

export type OnboardingDeps = {
  /** WEBHOOK_SECRET. Unset = every request is refused. */
  secret: string | undefined;
  intake: (body: OnboardingBody) => Promise<IntakeResult>;
};

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time: both sides are hashed first, so length does not leak either. */
export function secretMatches(given: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || !given) return false;
  return timingSafeEqual(digest(given), digest(secret));
}

function givenSecret(request: Request): string | null {
  const header = request.headers.get("x-webhook-secret");
  if (header) return header;
  const auth = request.headers.get("authorization");
  return auth && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "") : null;
}

const json = (body: unknown, status: number) => Response.json(body, { status });

export async function handleOnboarding(request: Request, deps: OnboardingDeps): Promise<Response> {
  if (!secretMatches(givenSecret(request), deps.secret)) return json({ error: "unauthorised" }, 401);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }
  const parsed = onboardingBody.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "body"}: ${i.message}`);
    return json({ error: `Invalid onboarding payload. ${problems.join("; ")}`, problems }, 400);
  }

  try {
    const result = await deps.intake(parsed.data);
    return json({ ok: true, ...result }, 200);
  } catch (err) {
    console.error("onboarding webhook:", (err as Error).message);
    return json({ ok: false, error: "Could not record the onboarding. Send the same event_id again to retry." }, 500);
  }
}
