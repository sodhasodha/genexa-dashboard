import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb, seedStaff } from "./db";

let db: PGlite;
const ids: Record<string, string> = {};
const owed = async (from = "app_today() - 6", to = "app_today()") =>
  Object.fromEntries((await db.query<{ name: string; terms: string; revenue: string; new_patients: string; owed: string }>(
    `select name, terms, revenue, new_patients, owed from rev_share_period(${from}, ${to})`)).rows.map((r) => [r.name, { terms: r.terms, revenue: Number(r.revenue), patients: Number(r.new_patients), owed: Number(r.owed) }]));
const buy = (clinic: string, contact: string, value: number, when: string, test = false) =>
  db.query(`insert into cortana_events (client_id, cortana_entry_id, contact_id, event, occurred_at, value, is_test) values ($1, $2, $3, 'purchase', ${when}, $4, $5)`,
    [ids[clinic], `${clinic}-${contact}-${Math.random()}`, contact, value, test]);

beforeAll(async () => {
  db = await freshDb();
  await seedStaff(db);
  for (const [key, name, extra] of [
    ["pct", "Percent Clinic", ""], ["own", "Own Rate Clinic", ", rev_share_rate = 0.1"],
    ["flat", "Per Patient Clinic", ", rev_share_type = 'per_patient', rev_share_per_patient = 150"], ["none", "No Share Clinic", ", rev_share_type = 'none'"],
  ] as const) {
    ids[key] = (await db.query<{ id: string }>(`insert into clients (name, stage) values ($1, 'live') returning id`, [name])).rows[0].id;
    if (extra) await db.query(`update clients set name = name ${extra} where id = $1`, [ids[key]]);
  }
});

describe("rev share by clinic terms", () => {
  it("5% by default, a clinic's own rate, a fixed amount per new paying patient, or nothing", async () => {
    for (const k of ["pct", "own", "flat", "none"]) {
      await buy(k, "a", 4000, "now() - interval '2 days'");
      await buy(k, "b", 6000, "now() - interval '1 day'");
    }
    const r = await owed();
    expect(r["Percent Clinic"]).toEqual({ terms: "5% of clinic revenue", revenue: 10000, patients: 2, owed: 500 });
    expect(r["Own Rate Clinic"]).toMatchObject({ terms: "10% of clinic revenue", owed: 1000 });
    expect(r["Per Patient Clinic"]).toEqual({ terms: "$150 per new paying patient", revenue: 10000, patients: 2, owed: 300 });
    expect(r["No Share Clinic"]).toEqual({ terms: "No rev share", revenue: 10000, patients: 2, owed: 0 });
  });

  it("a patient paying again is not a new patient, in this period or a later one; test contacts never count", async () => {
    await buy("flat", "a", 2000, "now()"); // second instalment, same period
    await buy("flat", "t", 9000, "now() - interval '1 hour'", true);
    expect((await owed())["Per Patient Clinic"]).toEqual({ terms: "$150 per new paying patient", revenue: 12000, patients: 2, owed: 300 });
    // A period containing only the later instalment: revenue, but nobody new.
    expect((await owed("app_today()", "app_today()"))["Per Patient Clinic"]).toMatchObject({ patients: 0, owed: 0 });
  });

  it("per patient needs an amount", async () => {
    await expect(db.query(`update clients set rev_share_type = 'per_patient', rev_share_per_patient = null where id = $1`, [ids.pct])).rejects.toThrow(/clients_rev_share_per_patient_set/);
  });
});
