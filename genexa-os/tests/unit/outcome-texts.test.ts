import { describe, expect, it } from "vitest";
import { plan, askText, remindText, confirmText, shortName, isBareFix, canText, isGenexaLead, type Ask, type Patient } from "@/lib/outcome-texts/plan";
import { parseReplyJson, buildReplyMessage } from "@/lib/outcome-texts/parse";

const TZ = "America/Chicago";
// 2026-11-04 is CST (UTC-6).
const at = (local: string) => new Date(`${local}-06:00`);
const patient = (over: Partial<Patient> = {}): Patient => ({ contact_id: "c1", name: "Jane Smith", stage: "appointments_booked", appointment: "2026-11-04T14:00:00-06:00", revenue: 0, ...over });
const ask = (over: Partial<Ask> = {}): Ask => ({
  id: "a1", patient_contact_id: "c1", patient_name: "Jane Smith", appointment_at: "2026-11-04T14:00:00-06:00", status: "asked",
  asked_at: at("2026-11-04T15:30:00").toISOString(), reminded_at: null, outcome: null, amount: null, logged_at: null, follow_up_at: null, ...over,
});
const LIVE = "2026-11-01T00:00:00Z";

describe("when the manager is texted", () => {
  it("asks an hour after a 30-minute appointment ends, not before", () => {
    expect(plan({ now: at("2026-11-04T15:29:00"), timeZone: TZ, liveFrom: LIVE, patients: [patient()], asks: [] }).ask).toHaveLength(0);
    expect(plan({ now: at("2026-11-04T15:30:00"), timeZone: TZ, liveFrom: LIVE, patients: [patient()], asks: [] }).ask).toHaveLength(1);
  });

  it("asks once per appointment, and never about one with an outcome already", () => {
    expect(plan({ now: at("2026-11-04T16:00:00"), timeZone: TZ, liveFrom: LIVE, patients: [patient()], asks: [ask()] }).ask).toHaveLength(0);
    expect(plan({ now: at("2026-11-04T16:00:00"), timeZone: TZ, liveFrom: LIVE, patients: [patient({ stage: "no_show" })], asks: [] }).ask).toHaveLength(0);
  });

  it("never texts a backlog from before it was switched on", () => {
    expect(plan({ now: at("2026-11-04T16:00:00"), timeZone: TZ, liveFrom: "2026-11-04T21:00:00Z", patients: [patient()], asks: [] }).ask).toHaveLength(0);
  });

  it("holds questions between 9 PM and 8 AM clinic time", () => {
    const late = patient({ appointment: "2026-11-04T20:00:00-06:00" });
    expect(canText(at("2026-11-04T21:30:00"), TZ)).toBe(false);
    expect(plan({ now: at("2026-11-04T21:30:00"), timeZone: TZ, liveFrom: LIVE, patients: [late], asks: [] }).ask).toHaveLength(0);
    expect(plan({ now: at("2026-11-05T08:00:00"), timeZone: TZ, liveFrom: LIVE, patients: [late], asks: [] }).ask).toHaveLength(1);
  });

  it("re-pings once the next morning, then never again", () => {
    const morning = at("2026-11-05T09:05:00");
    expect(plan({ now: at("2026-11-04T20:00:00"), timeZone: TZ, liveFrom: LIVE, patients: [patient()], asks: [ask()] }).remind).toHaveLength(0);
    expect(plan({ now: at("2026-11-05T08:30:00"), timeZone: TZ, liveFrom: LIVE, patients: [patient()], asks: [ask()] }).remind).toHaveLength(0);
    expect(plan({ now: morning, timeZone: TZ, liveFrom: LIVE, patients: [patient()], asks: [ask()] }).remind).toHaveLength(1);
    expect(plan({ now: morning, timeZone: TZ, liveFrom: LIVE, patients: [patient()], asks: [ask({ status: "reminded" })] }).remind).toHaveLength(0);
  });

  it("stops asking when the clinic logs it on the dashboard or the appointment moves", () => {
    const now = at("2026-11-05T09:05:00");
    expect(plan({ now, timeZone: TZ, liveFrom: LIVE, patients: [patient({ stage: "closed_won" })], asks: [ask()] }).close).toHaveLength(1);
    expect(plan({ now, timeZone: TZ, liveFrom: LIVE, patients: [patient({ appointment: "2026-11-10T10:00:00-06:00" })], asks: [ask()] }).close).toHaveLength(1);
  });

  it("asks 48 hours after 'thinking about it', unless they have closed since", () => {
    const thinking = ask({ status: "thinking", outcome: "not_closed", follow_up_at: at("2026-11-06T16:00:00").toISOString() });
    expect(plan({ now: at("2026-11-06T15:55:00"), timeZone: TZ, liveFrom: LIVE, patients: [patient({ stage: "not_closed" })], asks: [thinking] }).followUp).toHaveLength(0);
    expect(plan({ now: at("2026-11-06T16:00:00"), timeZone: TZ, liveFrom: LIVE, patients: [patient({ stage: "not_closed" })], asks: [thinking] }).followUp).toHaveLength(1);
    expect(plan({ now: at("2026-11-06T16:00:00"), timeZone: TZ, liveFrom: LIVE, patients: [patient({ stage: "closed_won" })], asks: [thinking] }).close).toHaveLength(1);
  });
});

describe("what the texts say", () => {
  it("names the patient and the appointment time", () => {
    expect(askText(patient(), TZ)).toBe("Log outcome of Jane Smith (2 PM appt). Reply: Closed + amount / No Show / Show - Thinking about it");
  });

  it("lists several reminders in one text", () => {
    const t = remindText([ask(), ask({ id: "a2", patient_name: "Mike Ross" })], TZ);
    expect(t).toContain("- Jane Smith (Wed, Nov 4 2 PM)");
    expect(t).toContain("- Mike Ross");
  });

  it("confirms back what was logged, and asks for a missing amount", () => {
    expect(confirmText([{ name: "Jane Smith", outcome: "closed_won", amount: 8500 }, { name: "Mike Ross", outcome: "no_show", amount: null }], []))
      .toBe("Logged: Jane S closed $8,500. Mike R no-show. Reply FIX to change.");
    expect(confirmText([{ name: "Jane Smith", outcome: "closed_won", amount: null }], [])).toContain("What was the amount for Jane S?");
    expect(confirmText([{ name: "Jane Smith", outcome: "thinking", amount: null }], [])).toBe("Logged: Jane S showed, thinking about it. Reply FIX to change.");
  });

  it("shortens names and spots a bare FIX", () => {
    expect(shortName("Reymundo Gallardo Jr.")).toBe("Reymundo G");
    expect(shortName("Anne")).toBe("Anne");
    expect(isBareFix(" fix ")).toBe(true);
    expect(isBareFix("FIX Jane closed 5k")).toBe(false);
  });
});

describe("reading the manager's reply", () => {
  it("keeps only patients he was asked about, once each, and drops amounts on non-closes", () => {
    const p = parseReplyJson({ outcomes: [{ ref: 1, outcome: "closed_won", amount: 8500 }, { ref: 1, outcome: "no_show", amount: null }, { ref: 2, outcome: "no_show", amount: 50 }, { ref: 9, outcome: "no_show", amount: null }], unclear: false }, new Set([1, 2]));
    expect(p.outcomes).toEqual([{ ref: 1, outcome: "closed_won", amount: 8500 }, { ref: 2, outcome: "no_show", amount: null }]);
    expect(p.unclear).toBe(true);
  });

  it("gives the model the patients, the conversation and the reply, marked as data", () => {
    const m = buildReplyMessage({ clinic: "Vitale", reply: "she closed 8.5k", candidates: [{ ref: 1, name: "Jane Smith", appointment: "Wed 2 PM", standing: "waiting" }], recentTexts: [{ direction: "out", body: "Log outcome of Jane Smith" }] });
    expect(m).toContain("ref 1: Jane Smith");
    expect(m).toContain("Genexa: Log outcome of Jane Smith");
    expect(m).toContain("<reply>\nshe closed 8.5k\n</reply>");
  });
});

describe("a question that could not be texted", () => {
  it("is asked again on the next run", () => {
    expect(plan({ now: at("2026-11-04T16:00:00"), timeZone: TZ, liveFrom: LIVE, patients: [patient()], asks: [ask({ status: "unsent" })] }).ask).toHaveLength(1);
  });
});

describe("patients who didn't come from Genexa", () => {
  it("are told apart by the ad attribution GHL keeps on the contact", () => {
    expect(isGenexaLead({ source: "Facebook", attributionSource: { medium: "facebook", sessionSource: "Paid Social", campaign: "Genexa | Fresh Batch | 21 Oct" } })).toBe(true);
    expect(isGenexaLead({ source: "Organic" })).toBe(false);
    expect(isGenexaLead({ source: null, attributionSource: { medium: "manual", campaign: "Podcast" } })).toBe(false);
  });

  it("are never asked about or reminded about once marked", () => {
    const now = at("2026-11-05T09:05:00");
    const p = plan({ now, timeZone: TZ, liveFrom: LIVE, patients: [patient()], asks: [ask({ status: "not_ours" })] });
    expect(p.ask).toHaveLength(0);
    expect(p.remind).toHaveLength(0);
  });

  it("are confirmed back when the manager says so", () => {
    expect(confirmText([{ name: "Chelisa Corey", outcome: "not_ours", amount: null }], [])).toBe("Logged: Chelisa C not from our ads, won't ask again. Reply FIX to change.");
  });
});
