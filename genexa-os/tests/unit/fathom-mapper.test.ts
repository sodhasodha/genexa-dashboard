import { describe, expect, it } from "vitest";
import { FathomMeetingsResponse, mapMeeting, type FathomContext } from "@/lib/integrations/fathom/mapper";
import fixture from "../../fixtures/fathom/meetings_redacted.json";

const meetings = FathomMeetingsResponse.parse(fixture).items;
const byTitle = (t: string) => meetings.find((m) => m.title === t)!;
const client = (id: string, name: string, contact_name: string | null, emails: string[] = []) => ({ id, name, contact_name, kickoff_url: null, whop_customer_ids: [], emails });
const ctx: FathomContext = {
  clients: [client("quantum", "Quantum Medical & Wellness Center", "Dave Popkin"), client("vitale", "Vitale Health Clinic", "Mitch Duquesnel"), client("reviv", "Reviv Florida", "Robert")],
  prospects: [{ id: "p1", name: "Dr Kevin Polzin" }],
  staffEmails: ["owner@genexascaling.com"],
};

describe("Fathom meetings (real response shape, emails replaced)", () => {
  it("parses a real page", () => {
    expect(meetings.length).toBe(10);
  });
  it("matches a client by contact name, short forms included", () => {
    expect(mapMeeting(byTitle("David Popkin - Onboarding Call"), ctx)).toMatchObject({ kind: "client", client_id: "quantum", external_names: ["Dave Popkin"], external_domains: ["gmail.com"] });
  });
  it("matches a client by the clinic's own email domain", () => {
    expect(mapMeeting(byTitle("Mitchell x Samantha x Ryan"), ctx)).toMatchObject({ kind: "client", client_id: "vitale" });
    expect(mapMeeting(byTitle("Dr. Robert Abraham - Onboarding Call"), ctx)).toMatchObject({ kind: "client", client_id: "reviv" });
  });
  it("a call with nobody from outside is internal; staff on personal emails count as inside", () => {
    expect(mapMeeting(byTitle("Impromptu Google Meet Meeting"), ctx).kind).toBe("internal");
    const training = byTitle("team training");
    const staffEmails = [...ctx.staffEmails, ...(training.calendar_invitees ?? []).map((i) => i.email as string)];
    expect(mapMeeting(training, { ...ctx, staffEmails }).kind).toBe("internal");
  });
  it("uses the name in the title when nobody else is on the invite", () => {
    const m = { ...byTitle("Impromptu Google Meet Meeting"), title: "Genexa Scaling x Mitch Duquesnel" };
    expect(mapMeeting(m, ctx)).toMatchObject({ kind: "client", client_id: "vitale" });
    expect(mapMeeting({ ...m, title: "Kevin Polzin - Follow Up" }, ctx)).toMatchObject({ kind: "prospect", prospect_id: "p1" });
    expect(mapMeeting({ ...m, title: "Genexa Scaling x Somebody Unknown" }, ctx).kind).toBe("internal");
  });
  it("someone outside who is not a client or a known prospect is unmatched, never guessed", () => {
    expect(mapMeeting(byTitle("Close AI Catchup"), ctx)).toMatchObject({ kind: "unmatched", client_id: null, prospect_id: null });
  });
  it("matches an existing prospect by full name and stores no email address", () => {
    const m = { ...byTitle("Close AI Catchup"), calendar_invitees: [{ name: "Kevin Polzin", email: "kp@example.org", email_domain: "example.org", is_external: true }] };
    const row = mapMeeting(m, ctx);
    expect(row).toMatchObject({ kind: "prospect", prospect_id: "p1" });
    expect(JSON.stringify({ ...row, recorded_by_email: null })).not.toContain("@");
  });
});
