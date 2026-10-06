import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

const MIGRATIONS = join(__dirname, "../../supabase/migrations");

/** A fresh in-process Postgres with the Supabase shim and every migration applied. */
export async function freshDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(readFileSync(join(__dirname, "supabase_shim.sql"), "utf8"));
  for (const file of readdirSync(MIGRATIONS).sort()) {
    if (!file.endsWith(".sql")) continue;
    try {
      await db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
    } catch (err) {
      throw new Error(`${file}: ${(err as Error).message}`);
    }
  }
  return db;
}

/** Run fn as a logged-in Supabase user (role authenticated, RLS on). */
export async function asUser<T>(db: PGlite, authUserId: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(
    `select set_config('request.jwt.claims', '${JSON.stringify({ sub: authUserId, role: "authenticated" })}', false); set role authenticated;`,
  );
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claims', '', false);`);
  }
}

export async function asAnon<T>(db: PGlite, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role anon;`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role;`);
  }
}

export type TestPeople = { ryan: string; aditya: string; sameer: string; amanda: string; marjorie: string };
export const AUTH: TestPeople = {
  ryan: "00000000-0000-0000-0000-000000000001",
  aditya: "00000000-0000-0000-0000-000000000002",
  sameer: "00000000-0000-0000-0000-000000000003",
  amanda: "00000000-0000-0000-0000-000000000004",
  marjorie: "00000000-0000-0000-0000-000000000005",
};

/** Test staff. Returns staff ids keyed like AUTH. */
export async function seedStaff(db: PGlite): Promise<TestPeople> {
  const rows: [keyof TestPeople, string, string, string | null][] = [
    ["ryan", "Ryan", "owner", null],
    ["aditya", "Aditya", "media_buyer", null],
    ["sameer", "Sameer", "tech", null],
    ["amanda", "Amanda Harder", "csr", "pod_2"],
    ["marjorie", "Marjorie Grace Villarino", "csr", "pod_1"],
  ];
  const out = {} as TestPeople;
  for (const [key, name, role, pod] of rows) {
    const r = await db.query<{ id: string }>(
      `insert into staff (auth_user_id, name, email, role, pod) values ($1, $2, $3, $4, $5) returning id`,
      [AUTH[key], name, `${key}@example.test`, role, pod],
    );
    out[key] = r.rows[0].id;
  }
  return out;
}
