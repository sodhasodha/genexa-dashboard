// Typed mapper for Mercury's /transactions. Pure. Field names from a real response.
import { z } from "zod";

export const MercuryTransaction = z
  .object({
    id: z.string(),
    amount: z.number(),
    status: z.string(),
    kind: z.string().nullable().optional(),
    postedAt: z.string().nullable().optional(),
    createdAt: z.string(),
    counterpartyName: z.string().nullable().optional(),
    bankDescription: z.string().nullable().optional(),
    mercuryCategory: z.string().nullable().optional(),
  })
  .loose();
export type MercuryTransaction = z.infer<typeof MercuryTransaction>;
export const MercuryTransactionsResponse = z.object({ transactions: z.array(MercuryTransaction) }).loose();

/**
 * A transaction as a stored row, or null for one that never happened (failed / cancelled).
 * Money in is positive, money out negative, exactly as Mercury reports it.
 * Category is not set here: the finance rules decide it.
 */
export function mapTransaction(t: MercuryTransaction) {
  if (t.status !== "sent" && t.status !== "pending") return null;
  return {
    mercury_id: t.id,
    posted_at: t.postedAt ?? t.createdAt,
    amount: Math.round(t.amount * 100) / 100,
    counterparty: t.counterpartyName?.trim() || t.bankDescription?.trim() || null,
    description: t.bankDescription?.trim() || null,
    kind: t.kind ?? null,
    mercury_category: t.mercuryCategory ?? null,
  };
}
