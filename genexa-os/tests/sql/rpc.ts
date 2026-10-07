import type { PGlite } from "@electric-sql/pglite";
import type { Rpc } from "@/lib/jobs/rpc";

/**
 * Calls a SQL function by name on the test database and returns what the
 * Supabase client would: an array of row objects for a set-returning function,
 * otherwise the value itself. Numbers come back as JSON numbers.
 */
export function pgliteRpc(db: PGlite): Rpc {
  return async <T>(fn: string, args: Record<string, unknown> = {}) => {
    if (!/^[a-z_]+$/.test(fn)) throw new Error(`bad function name: ${fn}`);
    const keys = Object.keys(args);
    const call = `${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
    const values = keys.map((k) => {
      const v = args[k];
      return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
    });
    const meta = await db.query<{ proretset: boolean; rettype: string }>(
      `select proretset, prorettype::regtype::text as rettype from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`, [fn]);
    if (meta.rows.length !== 1) throw new Error(`${fn}: expected one function, found ${meta.rows.length}`);
    const sql = meta.rows[0].proretset
      ? `select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as r from ${call} t`
      : meta.rows[0].rettype === "void" ? `select null as r from (select ${call}) x` : `select to_jsonb(${call}) as r`;
    try {
      const res = await db.query<{ r: T }>(sql, values);
      return res.rows[0].r;
    } catch (err) {
      throw new Error(`${fn}: ${(err as Error).message}`);
    }
  };
}
