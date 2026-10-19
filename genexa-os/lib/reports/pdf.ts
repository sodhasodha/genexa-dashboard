// The one-page client report, as a PDF. Pure: numbers in, bytes out.
// Only what a clinic should see: no internal notes, rev share or health colours.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { LOGO_PNG_BASE64 } from "./logo";

export type ReportNumbers = {
  clinic: string;
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  spend: number;
  leads: number;
  booked: number;
  shows: number;
  closes: number;
  revenue: number;
};

const INK = rgb(0.09, 0.1, 0.12);
const MUTED = rgb(0.42, 0.45, 0.5);
const LINE = rgb(0.88, 0.89, 0.91);
const DARK = rgb(0.086, 0.094, 0.114);
const ORANGE = rgb(0.91, 0.42, 0.16);
// The funnel steps, lightest to strongest orange.
const STEP = [rgb(0.99, 0.86, 0.76), rgb(0.97, 0.72, 0.55), rgb(0.95, 0.57, 0.33), ORANGE];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "1 to 30 September 2026", "28 September to 4 October 2026", "15 December 2025 to 14 January 2026". */
export function rangeLabel(from: string, to: string): string {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  if (fy === ty && fm === tm) return fd === td ? `${fd} ${MONTHS[fm - 1]} ${fy}` : `${fd} to ${td} ${MONTHS[tm - 1]} ${ty}`;
  if (fy === ty) return `${fd} ${MONTHS[fm - 1]} to ${td} ${MONTHS[tm - 1]} ${ty}`;
  return `${fd} ${MONTHS[fm - 1]} ${fy} to ${td} ${MONTHS[tm - 1]} ${ty}`;
}

export const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
export const roasText = (revenue: number, spend: number) => (spend > 0 ? `${(revenue / spend).toFixed(1)}x` : "n/a");
const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((100 * part) / whole)}%` : "");

/** The standard PDF fonts only cover Western characters: "REVĪV" becomes "REVIV", anything else unknown is dropped. */
export const pdfSafe = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E\u00A0-\u00FF]/g, "");

/** Text with a width limit: shrinks the size until it fits. */
function fitted(page: PDFPage, text: string, x: number, y: number, font: PDFFont, size: number, maxWidth: number, color = INK) {
  let s = size;
  while (s > 8 && font.widthOfTextAtSize(text, s) > maxWidth) s -= 1;
  page.drawText(text, { x, y, size: s, font, color });
}

export async function buildReportPdf(r: ReportNumbers): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${pdfSafe(r.clinic)} results, ${rangeLabel(r.from, r.to)}`);
  doc.setAuthor("Genexa Scaling");
  doc.setCreator("Genexa Scaling");
  const page = doc.addPage([612, 792]); // US Letter
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const logo = await doc.embedPng(Buffer.from(LOGO_PNG_BASE64, "base64"));
  const W = 612;
  const M = 48;

  // Header band.
  page.drawRectangle({ x: 0, y: 792 - 96, width: W, height: 96, color: DARK });
  page.drawImage(logo, { x: M, y: 792 - 76, width: 56, height: 56 });
  page.drawText("GENEXA SCALING", { x: M + 72, y: 792 - 46, size: 16, font: bold, color: rgb(1, 1, 1) });
  page.drawText("Patient acquisition results", { x: M + 72, y: 792 - 64, size: 10, font: regular, color: rgb(0.75, 0.77, 0.8) });
  page.drawRectangle({ x: 0, y: 792 - 100, width: W, height: 4, color: ORANGE });

  // Clinic and range.
  fitted(page, pdfSafe(r.clinic), M, 640, bold, 26, W - 2 * M);
  page.drawText(rangeLabel(r.from, r.to), { x: M, y: 618, size: 13, font: regular, color: MUTED });

  // Four big numbers.
  const cards = [
    { label: "AD SPEND", value: usd(r.spend) },
    { label: "APPOINTMENTS", value: r.booked.toLocaleString("en-US") },
    { label: "REVENUE", value: usd(r.revenue) },
    { label: "RETURN ON AD SPEND", value: roasText(r.revenue, r.spend) },
  ];
  const gap = 12;
  const cw = (W - 2 * M - 3 * gap) / 4;
  const top = 590;
  const ch = 96;
  cards.forEach((c, i) => {
    const x = M + i * (cw + gap);
    page.drawRectangle({ x, y: top - ch, width: cw, height: ch, color: rgb(0.975, 0.975, 0.98), borderColor: LINE, borderWidth: 1 });
    page.drawRectangle({ x, y: top - 3, width: cw, height: 3, color: ORANGE });
    page.drawText(c.label, { x: x + 12, y: top - 26, size: 8, font: bold, color: MUTED });
    fitted(page, c.value, x + 12, top - 66, bold, 28, cw - 24);
  });

  // Funnel: patients -> booked -> showed -> closed.
  page.drawText("HOW PATIENTS MOVED THROUGH", { x: M, y: 446, size: 9, font: bold, color: MUTED });
  const steps = [
    { label: "New patient enquiries", value: r.leads },
    { label: "Booked an appointment", value: r.booked },
    { label: "Showed up", value: r.shows },
    { label: "Became paying patients", value: r.closes },
  ];
  const max = Math.max(1, ...steps.map((s) => s.value));
  const barMax = W - 2 * M - 170 - 120; // room on the right for the step-to-step percentage
  const barH = 34;
  steps.forEach((s, i) => {
    const y = 404 - i * (barH + 16);
    const w = Math.max(6, (barMax * s.value) / max);
    page.drawText(s.label, { x: M, y: y + 13, size: 11, font: regular, color: INK });
    page.drawRectangle({ x: M + 170, y, width: w, height: barH, color: STEP[i] });
    const n = s.value.toLocaleString("en-US");
    const inside = bold.widthOfTextAtSize(n, 14) + 16 < w;
    page.drawText(n, { x: inside ? M + 170 + 10 : M + 170 + w + 8, y: y + 11, size: 14, font: bold, color: inside && i >= 2 ? rgb(1, 1, 1) : INK });
    if (i > 0) {
      const conv = pct(s.value, steps[i - 1].value);
      if (conv) {
        const t = `${conv} of the step before`;
        page.drawText(t, { x: W - M - regular.widthOfTextAtSize(t, 9), y: y + 13, size: 9, font: regular, color: MUTED });
      }
    }
  });

  // Footer.
  page.drawLine({ start: { x: M, y: 72 }, end: { x: W - M, y: 72 }, thickness: 1, color: LINE });
  page.drawText("Prepared by Genexa Scaling  |  genexascaling.com", { x: M, y: 54, size: 9, font: regular, color: MUTED });
  const note = "Figures are tracked by Cortana for this date range.";
  page.drawText(note, { x: W - M - regular.widthOfTextAtSize(note, 9), y: 54, size: 9, font: regular, color: MUTED });

  return doc.save();
}

/** "genexa-vitale-health-clinic-2026-09-01-to-2026-09-30.pdf" */
export function reportFileName(clinic: string, from: string, to: string): string {
  const slug = clinic.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `genexa-${slug || "clinic"}-${from}-to-${to}.pdf`;
}
