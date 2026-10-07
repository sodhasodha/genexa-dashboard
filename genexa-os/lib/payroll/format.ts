/** "$1,234.50". Payroll always shows cents. Null in, null out: the caller says what is missing. */
export function usd(value: number | null | undefined): string | null {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  return Number(value).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "11 Oct" from a YYYY-MM-DD date. */
export function dayMonth(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T12:00:00Z`);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]}`;
}
