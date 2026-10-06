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
