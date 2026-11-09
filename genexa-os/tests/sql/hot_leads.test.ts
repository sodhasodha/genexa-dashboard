import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asUser, freshDb, seedStaff } from "./db";

let db: PGlite;
let clinic: string;
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const all = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const lead = async (client: string, contact: string, reason = "mid_conversation") =>
  (await one<{ id: string }>(`insert into hot_leads (client_id, ghl_contact_id, patient_name, reason, signal_at) values ($1, $2, 'Jane Doe', $3, now()) returning id`, [client, contact, reason])).id;

beforeAll(async () => {
  db = await freshDb();
  await seedStaff(db);
  clinic = (await one<{ id: string }>(`insert into clients (name, stage, ghl_location_id) values ('Hot Clinic', 'live', 'LOC1') returning id`)).id;
});

describe("hot leads", () => {
  it("CSRs and the owner see the list with the clinic; nobody else does", async () => {
    const id = await lead(clinic, "c1");
    const row = await asUser(db, AUTH.amanda, () => one<{ id: string; clinic: string; ghl_location_id: string }>(`select id, clinic, ghl_location_id from hot_lead_list where id = $1`, [id]));
    expect(row).toEqual({ id, clinic: "Hot Clinic", ghl_location_id: "LOC1" });
    expect(await asUser(db, AUTH.ryan, () => all(`select 1 from hot_lead_list where id = $1`, [id]))).toHaveLength(1);
    expect(await asUser(db, AUTH.aditya, () => all(`select 1 from hot_lead_list`))).toEqual([]);
    expect(await asUser(db, AUTH.aditya, () => all(`select 1 from hot_leads`))).toEqual([]);
    // CSRs cannot write leads directly, or read the sync's per-contact memory.
    await expect(asUser(db, AUTH.amanda, () => db.query(`update hot_leads set reason = 'callback' where id = $1`, [id]))).resolves.toMatchObject({ affectedRows: 0 });
    expect(await asUser(db, AUTH.amanda, () => all(`select 1 from hot_lead_contacts`))).toEqual([]);
  });

  it("opening a lead records who and when, shown on the list; only CSRs and the owner can", async () => {
    const id = await lead(clinic, "c2");
    await asUser(db, AUTH.marjorie, () => db.query(`select hot_lead_open($1)`, [id]));
    expect(await one(`select opened_by from hot_lead_list where id = $1`, [id])).toEqual({ opened_by: "Marjorie Grace Villarino" });
    await asUser(db, AUTH.amanda, () => db.query(`select hot_lead_open($1)`, [id]));
    expect(await one(`select opened_by from hot_lead_list where id = $1`, [id])).toEqual({ opened_by: "Amanda Harder" });
    await expect(asUser(db, AUTH.sameer, () => db.query(`select hot_lead_open($1)`, [id]))).rejects.toThrow(/HOT_REFUSED/);
    await expect(asUser(db, AUTH.amanda, () => db.query(`select hot_lead_open(gen_random_uuid())`))).rejects.toThrow(/HOT_NOT_FOUND/);
  });

  it("dropped leads and churned clinics are off the list; nothing can be deleted", async () => {
    const gone = await lead(clinic, "c3");
    await db.query(`update hot_leads set dropped_at = now() where id = $1`, [gone]);
    const churned = (await one<{ id: string }>(`insert into clients (name, stage) values ('Old Clinic', 'churned') returning id`)).id;
    const old = await lead(churned, "c4");
    const ids = (await all<{ id: string }>(`select id from hot_lead_list`)).map((r) => r.id);
    expect(ids).not.toContain(gone);
    expect(ids).not.toContain(old);
    await expect(db.query(`delete from hot_leads where id = $1`, [gone])).rejects.toThrow();
    await expect(db.query(`insert into hot_leads (client_id, ghl_contact_id, reason, signal_at) values ($1, 'c5', 'missed_call', now())`, [clinic])).rejects.toThrow();
  });
});
