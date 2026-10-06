// Cortana REST client. Read-only. Cortana allows about 60 calls a minute, so
// calls are spaced out and a 429 is retried after a pause.
import { AttributionResponse, type AttributionRow } from "./mapper";

const DEFAULT_BASE = "https://app.usecortana.ai/api/v1";
const MIN_GAP_MS = 1100;
const MAX_TRIES = 4;

export type CortanaClient = {
  attribution: (businessId: string, range: { start: string; end: string }, groupBy: "campaign" | "ad") => Promise<AttributionRow[]>;
  businesses: () => Promise<{ id: string; name: string }[]>;
  calls: () => number;
};

export function createCortanaClient(opts: { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch; minGapMs?: number }): CortanaClient {
  const base = opts.baseUrl ?? DEFAULT_BASE;
  const doFetch = opts.fetchImpl ?? fetch;
  const gap = opts.minGapMs ?? MIN_GAP_MS;
  let nextAt = 0;
  let calls = 0;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function get(path: string): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      const wait = nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      nextAt = Date.now() + gap;
      calls++;
      const res = await doFetch(`${base}/${path}`, {
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json", "User-Agent": "genexa-os/1.0" },
        cache: "no-store",
      });
      if (res.ok) return res.json();
      if (res.status === 429 && attempt < MAX_TRIES) {
        await sleep((Number(res.headers.get("retry-after")) || 5 * attempt) * 1000);
        continue;
      }
      const text = await res.text().catch(() => "");
      throw new Error(`Cortana ${res.status} on ${path.split("?")[0]}${text ? `: ${text.slice(0, 160)}` : ""}`);
    }
  }

  return {
    calls: () => calls,
    async businesses() {
      const json = (await get("businesses")) as { data: { id: string; name: string }[] };
      return json.data;
    },
    async attribution(businessId, range, groupBy) {
      const qs = new URLSearchParams({ startDate: range.start, endDate: range.end, groupBy });
      const parsed = AttributionResponse.safeParse(await get(`businesses/${businessId}/attribution?${qs}`));
      if (!parsed.success) {
        throw new Error(`Cortana attribution response did not match the expected shape: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
      }
      return parsed.data.data.data;
    },
  };
}
