// Whop v2 REST client (direct, read-only). Lists are paged 50 at a time.
import { z } from "zod";
import { WhopMembership, WhopPage, WhopPayment, WhopPlan, WhopProduct } from "./mapper";

const BASE = "https://api.whop.com/api/v2";

export function createWhopClient(opts: { apiKey: string; fetchImpl?: typeof fetch }) {
  const doFetch = opts.fetchImpl ?? fetch;
  async function all<T extends z.ZodType>(path: string, item: T): Promise<z.infer<T>[]> {
    const out: z.infer<T>[] = [];
    for (let page = 1; page <= 200; page++) {
      const res = await doFetch(`${BASE}/${path}${path.includes("?") ? "&" : "?"}page=${page}&per=50`, {
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Whop ${res.status} on ${path}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
      const parsed = WhopPage(item).safeParse(await res.json());
      if (!parsed.success) throw new Error(`Whop ${path} did not match the expected shape: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
      out.push(...parsed.data.data);
      if (page >= parsed.data.pagination.total_page) return out;
    }
    throw new Error(`Whop ${path}: more than 200 pages`);
  }
  return {
    payments: () => all("payments", WhopPayment),
    memberships: () => all("memberships", WhopMembership),
    plans: () => all("plans", WhopPlan),
    products: () => all("products", WhopProduct),
  };
}
export type WhopClient = ReturnType<typeof createWhopClient>;
