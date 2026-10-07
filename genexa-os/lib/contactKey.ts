import { createHash } from "node:crypto";

/**
 * One-way key for "the same person" across systems, from a phone number
 * (preferred: last 10 digits) or an email. The raw value is never stored.
 */
export function contactKey(contact: { phone?: string | null; email?: string | null } | null | undefined): string | null {
  const digits = (contact?.phone ?? "").replace(/\D/g, "");
  if (digits.length >= 10) return `p:${createHash("sha256").update(digits.slice(-10)).digest("hex").slice(0, 32)}`;
  const email = (contact?.email ?? "").trim().toLowerCase();
  if (email.includes("@")) return `e:${createHash("sha256").update(email).digest("hex").slice(0, 32)}`;
  return null;
}
