import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUTH, asUser, freshDb, seedStaff } from "./db";

let db: PGlite;
let clinic: string;

beforeAll(async () => {
  db = await freshDb();
  await seedStaff(db);
  clinic = (await db.query<{ id: string }>(`insert into clients (name, stage) values ('Login Clinic', 'live') returning id`)).rows[0].id;
});

describe("client dashboard logins", () => {
  it("only the owner can save or read one; staff see nothing and cannot write", async () => {
    await asUser(db, AUTH.ryan, async () => {
      await db.query(`insert into client_dashboard_logins (client_id, username, password) values ($1, 'loginclinic', 'Example-Pass1')`, [clinic]);
      expect((await db.query(`select username from client_dashboard_logins`)).rows).toEqual([{ username: "loginclinic" }]);
    });
    for (const who of [AUTH.amanda, AUTH.sameer, AUTH.aditya]) {
      await asUser(db, who, async () => {
        expect((await db.query(`select 1 from client_dashboard_logins`)).rows).toEqual([]);
        expect((await db.query(`update client_dashboard_logins set password = 'x' returning id`)).rows).toEqual([]);
        await expect(db.query(`insert into client_dashboard_logins (client_id, username, password) values ($1, 'a', 'b')`, [clinic])).rejects.toThrow();
      });
    }
  });

  it("the password is kept in one place: not in the audit log, not in the nudge view, and never deleted", async () => {
    expect((await db.query(`select 1 from audit_log where table_name = 'client_dashboard_logins' or new_value like '%Example-Pass1%'`)).rows).toEqual([]);
    const cols = (await db.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'outcome_nudges_due'`)).rows.map((r) => r.column_name);
    expect(cols).not.toContain("password");
    await expect(db.query(`delete from client_dashboard_logins`)).rejects.toThrow();
  });
});
