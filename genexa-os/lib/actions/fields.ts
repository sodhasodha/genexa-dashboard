import { z } from "zod";

/** A form field as a trimmed string, or null when it was left empty. */
export function blank(v: FormDataEntryValue | null): string | null {
  return v === null || String(v).trim() === "" ? null : String(v).trim();
}

export const Id = z.uuid();
export const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
