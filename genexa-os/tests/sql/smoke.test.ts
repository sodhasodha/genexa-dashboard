import { describe, expect, it } from "vitest";
import { freshDb } from "./db";

describe("migrations", () => {
  it("apply cleanly", async () => {
    const db = await freshDb();
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    expect(r.rows[0].n).toBeGreaterThan(30);
  });
});
