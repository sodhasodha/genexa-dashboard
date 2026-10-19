import { describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => { throw new Error("not used"); } }));
import { buildReportPdf, pdfSafe, rangeLabel, reportFileName, roasText, usd } from "@/lib/reports/pdf";
import { parseReportRange, presetRange } from "@/lib/queries/reports";

const sample = { clinic: "REVĪV Regenerative Medicine", from: "2026-09-01", to: "2026-09-30", spend: 2107.02, leads: 77, booked: 21, shows: 9, closes: 3, revenue: 14500 };

describe("client report PDF", () => {
  it("is one page, titled with the clinic and the range", async () => {
    const bytes = await buildReportPdf(sample);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe("REVIV Regenerative Medicine results, 1 to 30 September 2026");
    expect(doc.getAuthor()).toBe("Genexa Scaling");
  });

  it("copes with no spend and an empty funnel", async () => {
    const doc = await PDFDocument.load(await buildReportPdf({ ...sample, spend: 0, leads: 0, booked: 0, shows: 0, closes: 0, revenue: 0 }));
    expect(doc.getPageCount()).toBe(1);
    expect(roasText(0, 0)).toBe("n/a");
  });

  it("formats ranges, money, ROAS, names and file names", () => {
    expect(rangeLabel("2026-09-01", "2026-09-30")).toBe("1 to 30 September 2026");
    expect(rangeLabel("2026-09-19", "2026-10-18")).toBe("19 September to 18 October 2026");
    expect(rangeLabel("2025-12-15", "2026-01-14")).toBe("15 December 2025 to 14 January 2026");
    expect(usd(2107.02)).toBe("$2,107");
    expect(roasText(14500, 2107.02)).toBe("6.9x");
    expect(pdfSafe("REVĪV → Café")).toBe("REVIV  Cafe");
    expect(reportFileName("Dr Darren - Pivotal Health (Lake Worth)", "2026-09-01", "2026-09-30")).toBe("genexa-dr-darren-pivotal-health-lake-worth-2026-09-01-to-2026-09-30.pdf");
  });
});

describe("report date ranges", () => {
  it("last 30 days ends yesterday; last calendar month is the whole previous month", () => {
    expect(presetRange("last_30", "2026-10-19")).toEqual({ from: "2026-09-19", to: "2026-10-18" });
    expect(presetRange("last_month", "2026-10-19")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(presetRange("last_month", "2026-03-01")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(presetRange("last_month", "2027-01-05")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("defaults to the last 30 days and refuses ranges that are backwards, in the future or before history", () => {
    expect(parseReportRange({}, "2026-10-19")).toEqual({ from: "2026-09-19", to: "2026-10-18", preset: "last_30" });
    expect(parseReportRange({ preset: "last_month" }, "2026-10-19")).toMatchObject({ from: "2026-09-01", preset: "last_month" });
    expect(parseReportRange({ from: "2026-09-01", to: "2026-09-30" }, "2026-10-19").preset).toBe("last_month");
    expect(parseReportRange({ from: "2026-09-05", to: "2026-09-12" }, "2026-10-19")).toEqual({ from: "2026-09-05", to: "2026-09-12", preset: "custom" });
    for (const bad of [{ from: "2026-09-12", to: "2026-09-05" }, { from: "2026-10-01", to: "2026-12-01" }, { from: "2026-07-01", to: "2026-07-31" }, { from: "x", to: "y" }]) {
      expect(parseReportRange(bad, "2026-10-19").preset).toBe("last_30");
    }
  });
});
