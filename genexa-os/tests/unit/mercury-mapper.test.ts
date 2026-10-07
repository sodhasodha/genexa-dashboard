import { describe, expect, it } from "vitest";
import { MercuryTransactionsResponse, mapTransaction } from "@/lib/integrations/mercury/mapper";
import fixture from "../../fixtures/mercury/transactions_sample.json";

const txs = MercuryTransactionsResponse.parse(fixture).transactions;

describe("Mercury transactions (real rows)", () => {
  it("keeps Mercury's sign: money in positive, money out negative", () => {
    const rows = txs.map(mapTransaction).filter((r) => r !== null);
    const by = (name: string) => rows.find((r) => r.counterparty?.startsWith(name));
    expect(by("Whop")?.amount).toBeGreaterThan(0);
    expect(by("Wise")?.amount).toBeLessThan(0);
    expect(by("Facebook")?.amount).toBeLessThan(0);
    expect(by("Facebook")).toMatchObject({ mercury_category: "Advertising" });
    expect(rows.every((r) => /^\d{4}-\d\d-\d\dT/.test(r.posted_at))).toBe(true);
  });
  it("drops a transaction that failed", () => {
    const failed = txs.find((t) => t.status === "failed");
    expect(failed).toBeDefined();
    expect(mapTransaction(failed!)).toBeNull();
  });
});
