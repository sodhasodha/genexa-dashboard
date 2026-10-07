// Mercury sync: bank transactions since a date, then the finance rules.
// Mercury only accepts calls from an allow-listed IP, so requests go through
// the Fixie static-IP proxy (FIXIE_URL) using Node's https module.
import https from "node:https";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpsProxyAgent } from "https-proxy-agent";
import { MercuryTransactionsResponse, mapTransaction } from "./mapper";

const BASE = "https://api.mercury.com/api/v1";
export type MercurySyncResult = { ok: boolean; transactions: number; categorised: number; unclassified: number; error: string | null };

function mercuryGet(path: string, apiKey: string, proxyUrl: string | undefined): Promise<unknown> {
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
  return new Promise((resolve, reject) => {
    https
      .get(`${BASE}${path}`, { agent, headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) return reject(new Error(`Mercury ${res.statusCode}: ${body.slice(0, 160)}`));
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("Mercury returned a non-JSON response"));
          }
        });
      })
      .on("error", reject);
  });
}

export async function syncMercury(opts: { db: SupabaseClient; apiKey: string; proxyUrl?: string; since: string }): Promise<MercurySyncResult> {
  const { db } = opts;
  const startedAt = new Date().toISOString();
  await db.from("integration_sync_status").update({ last_attempt_at: startedAt }).eq("source", "mercury");
  const result: MercurySyncResult = { ok: false, transactions: 0, categorised: 0, unclassified: 0, error: null };
  try {
    const rows: NonNullable<ReturnType<typeof mapTransaction>>[] = [];
    let cursor = "";
    for (let page = 0; page < 50; page++) {
      const qs = new URLSearchParams({ start: opts.since, limit: "1000", order: "asc" });
      qs.append("status[]", "sent");
      qs.append("status[]", "pending");
      if (cursor) qs.set("start_after", cursor);
      const parsed = MercuryTransactionsResponse.safeParse(await mercuryGet(`/transactions?${qs}`, opts.apiKey, opts.proxyUrl));
      if (!parsed.success) throw new Error(`Mercury transactions did not match the expected shape: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
      const batch = parsed.data.transactions;
      for (const t of batch) {
        const row = mapTransaction(t);
        if (row) rows.push(row);
      }
      if (batch.length < 1000) break;
      cursor = batch[batch.length - 1].id;
    }
    const synced_at = new Date().toISOString();
    for (let i = 0; i < rows.length; i += 500) {
      // category / included / categorised_by are left out: a re-sync must not undo a person's categorisation.
      const { error } = await db.from("finance_transactions").upsert(rows.slice(i, i + 500).map((r) => ({ ...r, synced_at })), { onConflict: "mercury_id" });
      if (error) throw new Error(`finance_transactions: ${error.message}`);
    }
    const applied = await db.rpc("apply_finance_rules");
    if (applied.error) throw new Error(`apply_finance_rules: ${applied.error.message}`);
    const left = await db.from("finance_transactions").select("id", { count: "exact", head: true }).eq("category", "unclassified");
    result.transactions = rows.length;
    result.categorised = Number(applied.data ?? 0);
    result.unclassified = left.count ?? 0;
    result.ok = true;
  } catch (err) {
    result.error = (err as Error).message;
  }
  const finishedAt = new Date().toISOString();
  await db.from("integration_sync_status").update({ status: result.ok ? "ok" : "error", rows_processed: result.transactions, error: result.error, ...(result.ok ? { last_success_at: finishedAt } : {}) }).eq("source", "mercury");
  await db.from("job_runs").insert({ job: "mercury-sync", started_at: startedAt, finished_at: finishedAt, ok: result.ok, rows_processed: result.transactions, error: result.error });
  return result;
}
