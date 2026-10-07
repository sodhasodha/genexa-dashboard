import { describe, expect, it } from "vitest";
import { AttributionResponse, accountTotals, adLevelAvailable, adTotals, campaignInScope } from "@/lib/integrations/cortana/mapper";
import { addDays, etMidnight, etRange, etToday } from "@/lib/time";
import campaign30d from "../../fixtures/cortana/attribution_groupBy_campaign_30d.json";
import campaignDay from "../../fixtures/cortana/attribution_groupBy_campaign.json";
import adDay from "../../fixtures/cortana/attribution_groupBy_ad.json";

const rows = (fixture: unknown) => AttributionResponse.parse(fixture).data.data;

describe("Cortana attribution mapper (real fixtures)", () => {
  it("parses real responses", () => {
    expect(rows(campaign30d).length).toBe(9);
    expect(rows(campaignDay).length).toBe(10);
    expect(rows(adDay).length).toBe(21);
  });

  it("sums only paid Meta campaigns: Beyond Stem Cells, 7 Sep - 6 Oct", () => {
    const t = accountTotals(rows(campaign30d), null);
    // 1454.98 + 0 + 15.37. "No Attribution Provided" (4 leads) and organic rows are not ads.
    expect(t.spend).toBe(1470.35);
    expect(t.campaigns_in_scope).toBe(3);
    expect(t.impressions).toBe(39829 + 331);
    expect(t.clicks).toBe(1947 + 10);
    expect(t.meta_leads).toBe(67);
    expect(t.cortana_leads).toBe(69);
    expect(t.cortana_booked).toBe(17);
    expect(t.cortana_revenue).toBe(1499);
    expect(t.ctr).toBeCloseTo((1957 / 40160) * 100, 6);
    expect(t.cpm).toBeCloseTo((1470.35 / 40160) * 1000, 4);
    expect(t.frequency).toBeCloseTo(40160 / (33684 + 297), 6);
  });

  it("matches the day total to the cent: Pivotal, 5 Oct", () => {
    expect(accountTotals(rows(campaignDay), null).spend).toBe(67.61);
    const ads = adTotals(rows(adDay), null);
    expect(Math.round(ads.reduce((a, r) => a + r.spend, 0) * 100) / 100).toBe(67.61);
    const top = ads.find((a) => a.ad_name === "Video Ad 1" && a.spend === 48.23);
    expect(top).toMatchObject({ ad_id: "120250634483090703", ad_status: "CAMPAIGN_PAUSED", impressions: 605, clicks: 12, leads: 4, booked: 0, frequency: 1.15019 });
  });

  it("limits a clinic to campaigns whose name contains its scope text", () => {
    const scope = { campaign_name_contains: "genexa", ad_account_ids: [] };
    const all = rows(campaignDay);
    const mine = all.filter((r) => campaignInScope(r, scope));
    expect(mine.every((r) => (r.dimension ?? "").startsWith("Genexa |"))).toBe(true);
    expect(mine.length).toBe(2);
    expect(accountTotals(all, scope).campaigns_in_scope).toBeLessThan(accountTotals(all, null).campaigns_in_scope);
    // Ad rows have no campaign on them, so a name-scoped clinic gets no ad-level rows.
    expect(adLevelAvailable(scope)).toBe(false);
    expect(adTotals(rows(adDay), scope)).toEqual([]);
  });

  it("limits a clinic to its own ad accounts", () => {
    const all = rows(campaignDay);
    expect(accountTotals(all, { campaign_name_contains: null, ad_account_ids: ["1032441997226344"] }).spend).toBe(67.61);
    expect(accountTotals(all, { campaign_name_contains: null, ad_account_ids: ["999"] })).toMatchObject({ spend: 0, campaigns_in_scope: 0, ctr: null, frequency: null });
  });
});

describe("ET day windows", () => {
  it("cuts days at midnight ET in summer and winter time", () => {
    expect(etMidnight("2026-10-05").toISOString()).toBe("2026-10-05T04:00:00.000Z");
    expect(etMidnight("2026-12-01").toISOString()).toBe("2026-12-01T05:00:00.000Z");
    expect(etRange("2026-10-05", "2026-10-05")).toEqual({ start: "2026-10-05T04:00:00.000Z", end: "2026-10-06T03:59:59.999Z" });
    // Clocks go back on 1 Nov 2026: that ET day is 25 hours long.
    expect(etRange("2026-11-01", "2026-11-01")).toEqual({ start: "2026-11-01T04:00:00.000Z", end: "2026-11-02T04:59:59.999Z" });
  });

  it("knows today's ET date and does calendar arithmetic", () => {
    expect(etToday(new Date("2026-10-07T02:30:00Z"))).toBe("2026-10-06");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

import { ConversionEntriesResponse, isTestContact, mapEvent, trackingTotals } from "@/lib/integrations/cortana/mapper";
import entriesFixture from "../../fixtures/cortana/conversions_entries_redacted.json";

describe("Cortana conversion events (real response shape, contact details replaced)", () => {
  const entries = ConversionEntriesResponse.parse(entriesFixture).data;
  const staff = [{ name: "Amanda Harder", email: "amanda@genexa.test" }];

  it("parses a real page and maps each counted event", () => {
    expect(entries.length).toBe(22);
    const events = entries.map((e) => mapEvent(e, staff)).filter((e) => e !== null);
    const count = (name: string) => events.filter((e) => e.event === name).length;
    expect([count("lead"), count("unconfirmed_appointment_booked"), count("appointment_booked"), count("appointment_shown"), count("appointment_no_show"), count("purchase")]).toEqual([2, 3, 4, 7, 1, 5]);
    const first = events[0];
    expect(first).toMatchObject({ event: "appointment_shown", attribution_source: "Instagram Organic", campaign_id: "120249604626100128", ad_id: "120249604626090128", ad_name: "Image AD Varitations" });
    expect(first.contact_first_name).toBe("Maria");
    expect(JSON.stringify(first)).not.toMatch(/Lopez|example\.org|\+1000/); // first name only
  });

  it("flags test contacts with the same rule as the database", () => {
    expect(isTestContact({ name: "Test Lead" }, staff)).toBe(true);
    expect(isTestContact({ name: "ZZ Sameer" }, staff)).toBe(true);
    expect(isTestContact({ name: "Amanda Harder" }, staff)).toBe(true);
    expect(isTestContact({ name: "Jo Bloggs", email: "qa+test@clinic.com" }, staff)).toBe(true);
    expect(isTestContact({ name: "Ana Testa", email: "atesta@gmail.com" }, staff)).toBe(false);
    expect(isTestContact({ name: "Maria Lopez", email: "latest.maria@gmail.com" }, staff)).toBe(false);
    expect(isTestContact(null, staff)).toBe(false);
  });

  it("ignores event types the app does not count", () => {
    expect(mapEvent({ ...entries[0], configName: "all_payments" }, staff)).toBeNull();
  });
});

describe("site tracking totals", () => {
  it("reads unique visitors from Cortana's own total and sums page views", () => {
    const t = trackingTotals(AttributionResponse.parse(campaign30d));
    expect(t.unique_visitors).toBe(1109);
    expect(t.page_views).toBeGreaterThan(0);
  });
});
