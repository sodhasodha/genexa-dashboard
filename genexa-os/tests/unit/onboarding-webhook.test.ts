import { describe, expect, it } from "vitest";
import { handleOnboarding, secretMatches, type IntakeResult, type OnboardingBody } from "@/lib/webhooks/onboarding";

const SECRET = "s3cret-value";
const CREATED: IntakeResult = { duplicate: false, client_id: "c1", client_created: true, launch_id: "l1", launch_created: true, message: "Created the client and its launch" };

function setup(result: IntakeResult | Error = CREATED, secret: string | undefined = SECRET) {
  const calls: OnboardingBody[] = [];
  const deps = {
    secret,
    intake: async (body: OnboardingBody) => {
      calls.push(body);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  const post = (body: unknown, headers: Record<string, string> = { "x-webhook-secret": SECRET }) =>
    handleOnboarding(
      new Request("https://os.test/api/webhooks/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      deps,
    );
  return { calls, post };
}
const valid = { event_id: "ev1", clinic_name: "New Clinic" };

describe("onboarding webhook: auth", () => {
  it("refuses a missing or wrong secret before reading the body", async () => {
    const { calls, post } = setup();
    const attempts: Record<string, string>[] = [{}, { "x-webhook-secret": "nope" }, { "x-webhook-secret": `${SECRET}x` }, { authorization: "Bearer nope" }, { authorization: SECRET }];
    for (const headers of attempts) {
      const res = await post("not even json", headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorised" });
    }
    expect(calls).toHaveLength(0);
  });

  it("accepts the secret in x-webhook-secret or as a Bearer token", async () => {
    const { calls, post } = setup();
    expect((await post(valid, { "x-webhook-secret": SECRET })).status).toBe(200);
    expect((await post(valid, { authorization: `Bearer ${SECRET}` })).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("refuses everything when WEBHOOK_SECRET is not set", async () => {
    const { post } = setup(CREATED, undefined);
    expect((await post(valid, { "x-webhook-secret": "" })).status).toBe(401);
    expect((await post(valid, { "x-webhook-secret": "undefined" })).status).toBe(401);
    expect(secretMatches("", "")).toBe(false);
    expect(secretMatches(SECRET, SECRET)).toBe(true);
  });
});

describe("onboarding webhook: validation", () => {
  it("passes a full payload through, trimmed", async () => {
    const { calls, post } = setup();
    const res = await post({
      event_id: " ev1 ", clinic_name: "  New Clinic ", contact_name: "Dr A", contact_email: "a@clinic.test", billing_cycle: "90",
      cycle_fee: 6000, paid_at: "2026-10-01T12:00:00Z", ob_form_done_at: "2026-10-02T09:30:00-04:00",
      kickoff_url: "https://k.test/1", drive_url: "https://drive.test/x", pod: "pod_2",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...CREATED });
    expect(calls[0]).toEqual({
      event_id: "ev1", clinic_name: "New Clinic", contact_name: "Dr A", contact_email: "a@clinic.test", billing_cycle: "90",
      cycle_fee: 6000, paid_at: "2026-10-01T12:00:00Z", ob_form_done_at: "2026-10-02T09:30:00-04:00",
      kickoff_url: "https://k.test/1", drive_url: "https://drive.test/x", pod: "pod_2",
    });
  });

  it("treats blank optional fields as absent", async () => {
    const { calls, post } = setup();
    const res = await post({ ...valid, contact_email: "", paid_at: null, kickoff_url: "", pod: "" });
    expect(res.status).toBe(200);
    expect(calls[0]).toEqual(valid);
  });

  it("answers 400 with a readable message, and creates nothing", async () => {
    const { calls, post } = setup();
    const bad: [unknown, RegExp][] = [
      ["{not json", /Body must be JSON/],
      [[valid], /Invalid onboarding payload/],
      [{ clinic_name: "X" }, /event_id/],
      [{ event_id: "e", clinic_name: "   " }, /clinic_name: is required/],
      [{ ...valid, billing_cycle: "60" }, /billing_cycle/],
      [{ ...valid, cycle_fee: "6000" }, /cycle_fee/],
      [{ ...valid, cycle_fee: -5 }, /cycle_fee/],
      [{ ...valid, paid_at: "last Tuesday" }, /paid_at: must be an ISO date-time/],
      [{ ...valid, paid_at: "2026-10-01T12:00:00" }, /paid_at/],
      [{ ...valid, contact_email: "not-an-email" }, /contact_email: must be an email address/],
      [{ ...valid, kickoff_url: "javascript:alert(1)" }, /kickoff_url/],
      [{ ...valid, pod: "pod_9" }, /pod/],
      [{ ...valid, clinicName: "typo" }, /clinicName/],
    ];
    for (const [body, message] of bad) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toMatch(message);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("onboarding webhook: results", () => {
  it("returns 200 with duplicate: true for a repeated event", async () => {
    const { post } = setup({ duplicate: true });
    const res = await post(valid);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
  });

  it("says when the client already existed", async () => {
    const existing: IntakeResult = { duplicate: false, client_id: "c1", client_created: false, launch_id: "l9", launch_created: true, message: "Client already exists: no second client created, a new launch was attached" };
    const res = await (setup(existing).post)(valid);
    expect(await res.json()).toMatchObject({ ok: true, client_created: false, launch_created: true, message: expect.stringMatching(/already exists/) });
  });

  it("answers 500 without leaking the database error", async () => {
    const { post } = setup(new Error("onboarding_intake: relation \"clients\" is on fire"));
    const res = await post(valid);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain("on fire");
  });
});
