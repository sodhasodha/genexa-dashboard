/** Helpers for naming the outside person on a Fathom call and suggesting who they are. */

const NOISE = ["genexa", "scaling", "call", "follow", "onboarding", "meeting", "with", "the", "and"];

export const callWords = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !NOISE.includes(w));

/**
 * The outside person's name. Sales calls are titled "Genexa Scaling x Name"; for
 * any other title ("30 min with Ryan (…)", "team training") the invitee's name is
 * the better answer. An invitee known only by email is not a name.
 */
export function callPerson(title: string | null, externalNames: string[]): string | null {
  const t = String(title ?? "").trim();
  const sales = /^genexa scaling\s*x\s*(.+)$/i.exec(t);
  if (sales) {
    const name = sales[1].replace(/\s*-\s*(onboarding call|follow up|patient generation call)\s*$/i, "").trim();
    if (name) return name;
  }
  const invitee = externalNames.find((n) => n.trim() && !n.includes("@"));
  if (invitee) return invitee.trim();
  return sales ? null : t.replace(/\s*-\s*(onboarding call|follow up|patient generation call)\s*$/i, "").trim() || null;
}

/**
 * How well a prospect or client name fits the call, or 0 for "do not suggest".
 * One shared word is enough only when the call gives a single name ("Gannon");
 * "David Bell" must not suggest "David Waltzer".
 */
export function callMatchScore(candidate: string, title: string | null, externalNames: string[]): number {
  const want = new Set([...callWords(callPerson(title, externalNames) ?? ""), ...callWords(String(title ?? "")), ...externalNames.filter((n) => !n.includes("@")).flatMap(callWords)]);
  const shared = callWords(candidate).filter((w) => want.has(w)).length;
  return shared >= 2 || (shared === 1 && want.size === 1) ? shared : 0;
}
