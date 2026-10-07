import { describe, expect, it } from "vitest";
import {
  WhopMembership, WhopPage, WhopPayment, WhopPlan, WhopProduct, mapMembership, mapPayment, matchWhopCustomer, type Catalog, type MatchClient,
} from "@/lib/integrations/whop/mapper";
import fixture from "../../fixtures/whop/sample_redacted.json";

const payments = WhopPage(WhopPayment).parse(fixture.payments).data;
const memberships = WhopPage(WhopMembership).parse(fixture.memberships).data;
const catalog: Catalog = {
  plans: new Map(WhopPage(WhopPlan).parse(fixture.plans).data.map((p) => [p.id, p])),
  products: new Map(WhopPage(WhopProduct).parse(fixture.products).data.map((p) => [p.id, p])),
};
const emails = new Map(memberships.filter((m) => m.user && m.email).map((m) => [m.user as string, m.email as string]));
const map = (i: number) => mapPayment(payments[i], catalog, emails, ["Irrigation Growth Plan"]);

describe("Whop payments (real rows, personal details replaced)", () => {
  it("stores a paid renewal with its product title from the plan", () => {
    expect(map(0)).toMatchObject({ status: "paid", amount: 5000, gross_amount: 5000, refunded_amount: 0, billing_reason: "subscription_cycle", product_title: "Genexa Scaling: Patient Protocol ™" });
    expect(map(0)?.paid_at).toMatch(/^2026-/);
  });
  it("keeps a payment with no product as unclassified (null title), never guessing one", () => {
    expect(map(1)).toMatchObject({ status: "paid", amount: 1500, product_title: null });
  });
  it("nets a partial refund off the amount", () => {
    expect(map(2)).toMatchObject({ status: "paid", amount: 141, gross_amount: 4000, refunded_amount: 3859 });
  });
  it("drops fully refunded and void payments, and the excluded product", () => {
    expect(map(3)).toBeNull();
    expect(map(5)).toBeNull();
    expect(map(6)).toBeNull();
  });
  it("keeps a failed charge as unpaid, with Whop's reason", () => {
    expect(map(4)).toMatchObject({ status: "open", amount: 1000 });
    expect(map(4)?.failure_message).toEqual(expect.any(String));
    expect(map(0)?.failure_message).toBeNull();
  });
});

describe("Whop memberships", () => {
  it("reads the renewal period and price from a renewing plan; one-off purchases have none", () => {
    const rows = memberships.map((m) => mapMembership(m, catalog));
    expect(rows.map((r) => [r.status, r.valid, r.billing_period_days, r.renewal_price])).toEqual([
      ["active", true, 30, 1000],
      ["active", true, 90, 5000],
      ["completed", true, null, null],
      ["canceled", false, 30, 397],
      ["active", true, 45, 2000],
    ]);
    expect(rows[1].renewal_period_end).toMatch(/^202\d-/);
  });
});

describe("matching a Whop customer to a client", () => {
  const c = (id: string, name: string, contact_name: string | null, extra: Partial<MatchClient> = {}): MatchClient => ({ id, name, contact_name, kickoff_url: null, whop_customer_ids: [], ...extra });
  const clients = [
    c("geo", "Georgia Interventional Pain Consultants", "Joshua Hare"),
    c("knox", "Dr Russell Smith Knoxville", "Russell Smith"),
    c("clev", "cleveland icp", "russel smith"),
    c("vit", "Vitale Health Clinic", "Mitch Duquesnel"),
    c("qua", "Quantum Medical & Wellness Center", "Dave Popkin"),
    c("bey", "Beyond Stem Cells", "John Comandari"),
    c("reg", "Regenestem", "Rick De Cubas"),
    c("pure", "Pure Health medical", "Matt Marcotte", { kickoff_url: "https://example.com/form?onboarding_client_id=1&email=drm%40example.org&x=1" }),
    c("gab", "dr gabriel", null),
    c("old", "Old Match", "Somebody Else", { whop_customer_ids: ["user_known"] }),
  ];
  const m = (names: string[], email: string | null = null, user_id: string | null = "user_x") => matchWhopCustomer({ user_id, names, email }, clients);

  it("trusts an earlier match first", () => {
    expect(m(["Totally Different"], null, "user_known")).toEqual({ client_id: "old", reason: "matched before" });
  });
  it("matches the email on the onboarding form", () => {
    expect(m(["8611 Columbus pike"], "drm@example.org")?.client_id).toBe("pure");
  });
  it("matches on surname plus an agreeing first name, including short forms", () => {
    expect(m(["JOSHUA LIDELLE HARE"])?.client_id).toBe("geo");
    expect(m(["Mitchell Duquesnel"])?.client_id).toBe("vit");
    expect(m(["David Popkin"])?.client_id).toBe("qua");
    expect(m(["Ricardo DeCubas"], "someone@regenestem.com")?.client_id).toBe("reg");
  });
  it("never matches on a surname two clients share", () => {
    expect(m(["Dr Russell Smith"])).toBeNull();
  });
  it("matches a clinic's own email domain, but not a webmail one", () => {
    expect(m(["Office Manager"], "info@beyondstemcells.com")?.client_id).toBe("bey");
    expect(m(["Office Manager"], "beyondstemcells@gmail.com")).toBeNull();
  });
  it("leaves everything else for a person to pick", () => {
    expect(m(["Gabriel Akinyemi"], "np@gmail.com")).toBeNull();
    expect(m(["Mitchell Someoneelse"])).toBeNull();
    expect(m([], null)).toBeNull();
  });
});
