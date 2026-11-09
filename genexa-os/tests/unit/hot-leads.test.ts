import { describe, expect, it } from "vitest";
import { CALLBACK_KEYWORDS, RESCHEDULE_KEYWORDS } from "@/lib/hotLeads/config";
import { decideLead, findKeyword, hasTag, leadTier, type LeadFacts } from "@/lib/hotLeads/rules";
import { appointmentFacts, latestInboundSms } from "@/lib/integrations/ghl/hotLeads";

const resched = (t: string) => findKeyword(t, RESCHEDULE_KEYWORDS);
const callback = (t: string) => findKeyword(t, CALLBACK_KEYWORDS);

describe("change-of-plans keywords", () => {
  it("match whatever the case, punctuation, word ending or small typo", () => {
    for (const t of ["I need to CANCEL", "Cancelled sorry", "can we reschedule?", "need to resched", "Can't make it tomorrow", "cant make it",
      "I wont make it", "I'm not going to make it", "something came up at work", "can we push back an hour", "please postpone",
      "running late!", "I'm sick", "family emergency", "can we do a different day", "another time maybe", "I need to cancle",
      "reschdule please", "cancellation", "Can I move my appointment", "can i change my appointment to friday"]) {
      expect(resched(t), t).not.toBeNull();
    }
  });

  it("do not match ordinary replies, look-alike words, or a keyword after don't / not / never", () => {
    for (const t of ["Yes I'll be there", "I can make it", "sounds good see you then", "I have cancer in my knee", "my cancerous lesion",
      "I don't want to cancel", "what time is it at", "ok", "thanks", "no", "I'm in a lot of pain"]) {
      expect(resched(t), t).toBeNull();
    }
  });

  it("callback asks are found; 'don't call me' is not one", () => {
    expect(callback("Can you call me after 5")).not.toBeNull();
    expect(callback("please give me a call")).not.toBeNull();
    expect(callback("call back tomorrow")).not.toBeNull();
    expect(callback("Don't call me again")).toBeNull();
    expect(callback("I'll be there")).toBeNull();
  });
});

const H = 3_600_000;
const NOW = Date.parse("2026-11-09T18:00:00Z");
const facts = (o: Partial<LeadFacts> = {}): LeadFacts => ({
  hidden: false, onDesk: false, upcoming: false, lastInboundAt: null, inboundReschedule: false, inboundCallback: false,
  callbackTag: false, lastMessageAt: null, ...o,
});

describe("who is hot", () => {
  it("anyone with an appointment to come is left out, unless their latest text (72h) wants to change it", () => {
    expect(decideLead(facts({ upcoming: true, lastInboundAt: NOW - H, callbackTag: true, lastMessageAt: NOW - H }), NOW)).toBeNull();
    expect(decideLead(facts({ upcoming: true, lastInboundAt: NOW - 60 * H, inboundReschedule: true }), NOW)).toMatchObject({ reason: "reschedule", signal_at: NOW - 60 * H });
    expect(decideLead(facts({ upcoming: true, lastInboundAt: NOW - 73 * H, inboundReschedule: true }), NOW)).toBeNull();
  });

  it("each reason and its window", () => {
    expect(decideLead(facts({ lastInboundAt: NOW - 47 * H }), NOW)?.reason).toBe("mid_conversation");
    expect(decideLead(facts({ lastInboundAt: NOW - 49 * H }), NOW)).toBeNull();
    expect(decideLead(facts({ lastInboundAt: NOW - 70 * H, inboundCallback: true }), NOW)?.reason).toBe("callback");
    expect(decideLead(facts({ callbackTag: true, lastMessageAt: NOW - 6 * 24 * H }), NOW)?.reason).toBe("callback");
    expect(decideLead(facts({ callbackTag: true, lastMessageAt: NOW - 8 * 24 * H }), NOW)).toBeNull();
  });

  it("anyone on the confirmation desk is never shown, even texting to reschedule", () => {
    expect(decideLead(facts({ onDesk: true, lastInboundAt: NOW - H, inboundReschedule: true }), NOW)).toBeNull();
    expect(decideLead(facts({ onDesk: true, lastInboundAt: NOW - H }), NOW)).toBeNull();
  });

  it("one badge per lead: reschedule, then callback, then mid conversation", () => {
    expect(decideLead(facts({ lastInboundAt: NOW - H, inboundReschedule: true, callbackTag: true, lastMessageAt: NOW }), NOW)?.reason).toBe("reschedule");
    expect(decideLead(facts({ lastInboundAt: NOW - H, callbackTag: true, lastMessageAt: NOW }), NOW)).toEqual({ reason: "callback", signal_at: NOW, last_reply_at: NOW - H });
    expect(decideLead(facts({ lastInboundAt: NOW - H }), NOW)?.reason).toBe("mid_conversation");
  });

  it("DNC and not interested are never shown, even wanting to reschedule", () => {
    expect(decideLead(facts({ hidden: true, lastInboundAt: NOW - H, inboundReschedule: true }), NOW)).toBeNull();
    expect(hasTag(["Facebook ads lead", " DNC "], ["dnc", "not interested"], true)).toBe(true);
    expect(hasTag(["dq | not interested"], ["dnc", "not interested"], true)).toBe(true);
    expect(hasTag(["wavv-not-interested"], ["dnc", "not interested"], true)).toBe(true);
    expect(hasTag(["disqualified by ai"], ["dnc", "not interested"], true)).toBe(false);
    expect(hasTag(["Requested Callback"], ["requested callback", "wavv-callback"])).toBe(true);
    expect(hasTag(["wavv-callback"], ["requested callback", "wavv-callback"])).toBe(true);
  });

  it("sorts: reschedule, texted in the last 2h, callback, then the rest", () => {
    const iso = (t: number) => new Date(t).toISOString();
    expect(leadTier({ reason: "reschedule", last_reply_at: null }, NOW)).toBe(0);
    expect(leadTier({ reason: "mid_conversation", last_reply_at: iso(NOW - H) }, NOW)).toBe(1);
    expect(leadTier({ reason: "callback", last_reply_at: iso(NOW - H) }, NOW)).toBe(1);
    expect(leadTier({ reason: "callback", last_reply_at: null }, NOW)).toBe(2);
    expect(leadTier({ reason: "mid_conversation", last_reply_at: iso(NOW - 3 * H) }, NOW)).toBe(4);
    expect(leadTier({ reason: "mid_conversation", last_reply_at: null }, NOW)).toBe(4);
  });
});

describe("reading GHL", () => {
  it("the latest text in is an inbound SMS (native or the dialer's), checked for keywords", () => {
    const m = (direction: string, messageType: string, body: string, dateAdded: string) => ({ direction, messageType, body, dateAdded });
    expect(latestInboundSms([
      m("outbound", "TYPE_CUSTOM_SMS", "Can't make it? reply", "2026-11-09T17:00:00Z"),
      m("inbound", "TYPE_CUSTOM_SMS", "I need to reschedule", "2026-11-09T16:00:00Z"),
      m("inbound", "TYPE_SMS", "call me", "2026-11-09T12:00:00Z"),
      m("inbound", "TYPE_EMAIL", "cancel", "2026-11-09T17:30:00Z"),
    ])).toEqual({ at: Date.parse("2026-11-09T16:00:00Z"), reschedule: true, callback: false });
    expect(latestInboundSms([m("outbound", "TYPE_SMS", "hi", "2026-11-09T17:00:00Z")])).toBeNull();
  });

  it("appointments on any calendar: only one still to come and not cancelled or no-show counts as upcoming", () => {
    const e = (contactId: string, startTime: string, appointmentStatus: string, dateUpdated = startTime) => ({ id: Math.random().toString(), contactId, startTime, appointmentStatus, dateUpdated });
    const f = appointmentFacts([
      e("a", "2026-11-12T15:00:00-06:00", "confirmed"),
      e("b", "2026-11-12T15:00:00-06:00", "cancelled", "2026-11-08T10:00:00Z"),
      e("c", "2026-11-05T15:00:00-06:00", "noshow"),
      e("d", "2026-11-12T15:00:00-06:00", "new"),
      e("d", "2026-11-01T15:00:00-06:00", "noshow"),
    ], NOW);
    expect([...f.upcoming].sort()).toEqual(["a", "d"]);
    expect(f.upcoming.has("b")).toBe(false);
  });
});
