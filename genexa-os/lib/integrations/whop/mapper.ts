// Typed mappers for Whop's v2 API (payments, memberships, plans, products).
// Pure functions. Field names come from real responses (fixtures/whop).
import { z } from "zod";

export const WhopPayment = z
  .object({
    id: z.string(),
    status: z.string(),
    user: z.string().nullable(),
    plan: z.string().nullable().optional(),
    product: z.string().nullable().optional(),
    membership: z.string().nullable().optional(),
    final_amount: z.number(),
    refunded_amount: z.number().nullable().optional(),
    created_at: z.number(),
    paid_at: z.number().nullable().optional(),
    billing_reason: z.string().nullable().optional(),
    failure_message: z.string().nullable().optional(),
    billing_first_name: z.string().nullable().optional(),
    billing_last_name: z.string().nullable().optional(),
    billing_address: z.object({ name: z.string().nullable().optional() }).loose().nullable().optional(),
  })
  .loose();
export type WhopPayment = z.infer<typeof WhopPayment>;

export const WhopMembership = z
  .object({
    id: z.string(),
    user: z.string().nullable(),
    product: z.string().nullable().optional(),
    plan: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    status: z.string(),
    valid: z.boolean(),
    cancel_at_period_end: z.boolean().nullable().optional(),
    renewal_period_start: z.number().nullable().optional(),
    renewal_period_end: z.number().nullable().optional(),
    created_at: z.number(),
  })
  .loose();
export type WhopMembership = z.infer<typeof WhopMembership>;

export const WhopPlan = z
  .object({ id: z.string(), product: z.string().nullable().optional(), plan_type: z.string().nullable().optional(), billing_period: z.number().nullable().optional(), renewal_price: z.union([z.string(), z.number()]).nullable().optional() })
  .loose();
export type WhopPlan = z.infer<typeof WhopPlan>;
export const WhopProduct = z.object({ id: z.string(), title: z.string().nullable().optional() }).loose();
export type WhopProduct = z.infer<typeof WhopProduct>;

export const WhopPage = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), pagination: z.object({ current_page: z.number(), total_page: z.number() }).loose() }).loose();

export type Catalog = { plans: Map<string, WhopPlan>; products: Map<string, WhopProduct> };
const ts = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000).toISOString() : null);
const cents = (n: number) => Math.round(n * 100) / 100;

/** A payment's product title: its own product, else the product its plan belongs to. */
export function productTitle(p: { product?: string | null; plan?: string | null }, catalog: Catalog): string | null {
  const productId = p.product ?? (p.plan ? catalog.plans.get(p.plan)?.product : null) ?? null;
  const title = productId ? catalog.products.get(productId)?.title : null;
  return title && title.trim() !== "" ? title.trim() : null;
}

export function customerName(p: WhopPayment): string | null {
  const name = p.billing_address?.name?.trim() || [p.billing_first_name, p.billing_last_name].filter(Boolean).join(" ").trim();
  return name || null;
}

export type PaymentRow = {
  whop_payment_id: string;
  whop_user_id: string | null;
  whop_membership_id: string | null;
  status: "paid" | "open";
  amount: number;
  gross_amount: number;
  refunded_amount: number;
  paid_at: string;
  product_title: string | null;
  billing_reason: string | null;
  failure_message: string | null;
  customer_name: string | null;
  customer_email: string | null;
};

/**
 * A Whop payment as a stored row, or null when it must not be stored:
 * void, fully refunded, or an excluded product. A paid payment's amount is
 * net of refunds. An open payment is a card charge that failed, dated when it was attempted.
 */
export function mapPayment(p: WhopPayment, catalog: Catalog, emailByUser: Map<string, string>, excludedProducts: string[]): PaymentRow | null {
  if (p.status !== "paid" && p.status !== "open") return null;
  const title = productTitle(p, catalog);
  if (title && excludedProducts.some((x) => x.toLowerCase() === title.toLowerCase())) return null;
  const refunded = p.refunded_amount ?? 0;
  const net = cents(p.final_amount - refunded);
  if (p.status === "paid" && net <= 0) return null;
  return {
    whop_payment_id: p.id,
    whop_user_id: p.user,
    whop_membership_id: p.membership ?? null,
    status: p.status,
    amount: p.status === "paid" ? net : cents(p.final_amount),
    gross_amount: cents(p.final_amount),
    refunded_amount: cents(refunded),
    paid_at: ts(p.status === "paid" ? (p.paid_at ?? p.created_at) : p.created_at) as string,
    product_title: title,
    billing_reason: p.billing_reason ?? null,
    failure_message: p.status === "open" ? (p.failure_message ?? null) : null,
    customer_name: customerName(p),
    customer_email: (p.user && emailByUser.get(p.user)) || null,
  };
}

export function mapMembership(m: WhopMembership, catalog: Catalog) {
  const plan = m.plan ? catalog.plans.get(m.plan) : undefined;
  const price = plan?.renewal_price === null || plan?.renewal_price === undefined ? null : Number(plan.renewal_price);
  // Only a renewing plan has a renewal date worth acting on.
  const recurring = plan?.plan_type === "renewal" && !!plan.billing_period;
  return {
    whop_membership_id: m.id,
    whop_user_id: m.user,
    email: m.email ?? null,
    product_title: productTitle(m, catalog),
    status: m.status,
    valid: m.valid,
    cancel_at_period_end: m.cancel_at_period_end ?? false,
    billing_period_days: recurring ? (plan?.billing_period ?? null) : null,
    renewal_price: recurring && price !== null && Number.isFinite(price) ? price : null,
    renewal_period_start: ts(m.renewal_period_start),
    renewal_period_end: ts(m.renewal_period_end),
    started_at: ts(m.created_at) as string,
  };
}

// ---------------------------------------------------------------------------
// Matching a Whop customer to a client
// ---------------------------------------------------------------------------
export type MatchClient = { id: string; name: string; contact_name: string | null; kickoff_url: string | null; whop_customer_ids: string[] };
export type CustomerMatch = { client_id: string; reason: string } | null;

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w !== "" && !["dr", "md", "do", "llc", "the"].includes(w));
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const kickoffEmail = (url: string | null) => {
  if (!url) return null;
  try {
    return new URL(url).searchParams.get("email")?.trim().toLowerCase() || null;
  } catch {
    return null;
  }
};

/**
 * Which client is this Whop customer? Only clear matches are returned; anything
 * else goes to the Data review queue for a person to pick.
 *  1. The Whop user id is already on a client (a person matched it before).
 *  2. The customer's email is the email on the client's onboarding form.
 *  3. Same surname as exactly one client contact, and the first names agree
 *     (equal, or one a short form of the other: Dave / David, Mitch / Mitchell).
 *  4. The email's domain is the clinic's name (info@beyondstemcells.com).
 * A surname shared by two clients' contacts is never matched on name.
 */
export function matchWhopCustomer(customer: { user_id: string | null; names: string[]; email: string | null }, clients: MatchClient[]): CustomerMatch {
  if (customer.user_id) {
    const known = clients.find((c) => c.whop_customer_ids.includes(customer.user_id as string));
    if (known) return { client_id: known.id, reason: "matched before" };
  }
  const email = customer.email?.trim().toLowerCase() ?? null;
  if (email) {
    const byEmail = clients.filter((c) => kickoffEmail(c.kickoff_url) === email);
    if (byEmail.length === 1) return { client_id: byEmail[0].id, reason: "email on the onboarding form" };
  }
  for (const name of customer.names) {
    const w = words(name);
    if (w.length < 2) continue;
    const [first, last] = [w[0], w[w.length - 1]];
    const sameSurname = clients.filter((c) => {
      const cw = words(c.contact_name ?? "");
      return cw.length >= 2 && cw[cw.length - 1] === last;
    });
    if (sameSurname.length !== 1) continue;
    const cFirst = words(sameSurname[0].contact_name as string)[0];
    const agrees = cFirst === first || cFirst.startsWith(first) || first.startsWith(cFirst) || (cFirst.length >= 3 && cFirst.slice(0, 3) === first.slice(0, 3));
    if (agrees) return { client_id: sameSurname[0].id, reason: `contact name "${sameSurname[0].contact_name}"` };
  }
  if (email) {
    const domain = squash(email.split("@")[1]?.split(".")[0] ?? "");
    const generic = ["gmail", "yahoo", "hotmail", "outlook", "icloud", "aol", "me", "live", "msn", "proton", "protonmail"];
    if (domain.length >= 6 && !generic.includes(domain)) {
      const byDomain = clients.filter((c) => {
        const n = squash(c.name);
        return n.length >= 6 && (n.includes(domain) || domain.includes(n));
      });
      if (byDomain.length === 1) return { client_id: byDomain[0].id, reason: `email domain ${email.split("@")[1]}` };
    }
  }
  return null;
}
