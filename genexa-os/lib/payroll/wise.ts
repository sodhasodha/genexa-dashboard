// Wise batch payment file. Pure: no database, no clock.
import { dayMonth } from "./format";

export type WiseLine = { name: string; email: string | null; total: number; status: string };

export const WISE_HEADER = "name,email,amount,currency,reference";

/** RFC 4180: quote a field holding a comma, quote, line break or outer space; double the quotes inside. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) || value !== value.trim() ? `"${value.replaceAll('"', '""')}"` : value;
}

/** "Genexa week ending 11 Oct" from the run's week_end (an ET date, YYYY-MM-DD). */
export const wiseReference = (weekEnd: string) => `Genexa week ending ${dayMonth(weekEnd)}`;

/** The lines that go in the file: approved, with money due. */
export const wiseLines = <T extends WiseLine>(lines: T[]): T[] =>
  lines.filter((l) => l.status === "approved" && Number(l.total) > 0);

/**
 * One row per approved line with a total above zero. A person with no email
 * still gets a row (blank email), so Wise rejects it loudly rather than the
 * person being dropped from the batch.
 */
export function buildWiseCsv(lines: WiseLine[], weekEnd: string): string {
  const reference = wiseReference(weekEnd);
  const rows = wiseLines(lines).map((l) =>
    [l.name, l.email ?? "", Number(l.total).toFixed(2), "USD", reference].map(csvField).join(","),
  );
  return [WISE_HEADER, ...rows].join("\r\n") + "\r\n";
}
