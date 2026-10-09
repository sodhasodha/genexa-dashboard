import { describe, expect, it } from "vitest";
import { accountDayRange, etRange } from "@/lib/time";
import { accountTotals, type AttributionRow } from "@/lib/integrations/cortana/mapper";

const row = (o: Partial<AttributionRow> & Record<string, unknown>) =>
  ({ dimension: "Campaign", customerId: "act_1", platformEntityId: "c1", spent: 0, impressions: 0, clicks: 0, reach: 0, frequency: 0, ctr: 0, metaPlatformLeads: 0, ...o }) as AttributionRow;

describe("ad account days", () => {
  it("asks Cortana for the account day itself: the UTC day, not ET midnight to midnight", () => {
    expect(accountDayRange("2026-10-08", "2026-10-08")).toEqual({ start: "2026-10-08T00:00:00.000Z", end: "2026-10-08T23:59:59.999Z" });
    // The old request for 8 Oct covered 00:00 UTC on 9 Oct, where Cortana files the NEXT account day.
    const old = etRange("2026-10-08", "2026-10-08");
    expect(old.start <= "2026-10-09T00:00:00.000Z" && "2026-10-09T00:00:00.000Z" <= old.end).toBe(true);
    expect(accountDayRange("2026-10-08", "2026-10-08").end < "2026-10-09T00:00:00.000Z").toBe(true);
  });

  it("reads the daily budget of the campaigns that ran, counting a shared budget once", () => {
    const t = accountTotals([
      row({ platformEntityId: "c1", spent: 44.76, effectiveStatus: "CAMPAIGN_PAUSED", summaryDailyBudget: 100, summaryBudgetKey: "campaign:a" }),
      row({ platformEntityId: "c2", spent: 0, effectiveStatus: "ACTIVE", summaryDailyBudget: 50, summaryBudgetKey: "campaign:b" }),
      row({ platformEntityId: "c3", spent: 0, effectiveStatus: "CAMPAIGN_PAUSED", summaryDailyBudget: 300, summaryBudgetKey: "campaign:c" }), // paused and silent: not part of the day
      row({ platformEntityId: "c4", spent: 5, effectiveStatus: "ACTIVE", summaryDailyBudget: 100, summaryBudgetKey: "campaign:a" }), // same budget as c1
    ], null);
    expect(t.daily_budget).toBe(150);
    expect(t.spend).toBe(49.76);
    expect(accountTotals([row({ spent: 10 })], null).daily_budget).toBeNull();
  });
});
