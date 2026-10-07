import { describe, expect, it } from "vitest";
import { dayMonth, usd } from "@/lib/payroll/format";
import { defaultPayWeek, isDate, payRunWeek, weekStartOf } from "@/lib/payroll/week";
import { buildWiseCsv, csvField, wiseReference } from "@/lib/payroll/wise";

describe("Wise batch CSV", () => {
  const lines = [
    { name: "Amanda Harder", email: "amanda@example.test", total: 102, status: "approved" },
    { name: "Aditya", email: "aditya@example.test", total: 0, status: "approved" }, // fixed pay, not due
    { name: "Marjorie Grace Villarino", email: "marjorie@example.test", total: 40, status: "draft" },
    { name: "Sameer", email: "sameer@example.test", total: 1000, status: "paid" }, // already paid
    { name: "Freddie Lance", email: "freddie@example.test", total: 150.5, status: "approved" },
  ];

  it("has the header and one row per approved line with a total above zero", () => {
    expect(buildWiseCsv(lines, "2026-10-11")).toBe(
      "name,email,amount,currency,reference\r\n" +
        "Amanda Harder,amanda@example.test,102.00,USD,Genexa week ending 11 Oct\r\n" +
        "Freddie Lance,freddie@example.test,150.50,USD,Genexa week ending 11 Oct\r\n",
    );
  });

  it("is only the header when nothing is approved", () => {
    expect(buildWiseCsv([], "2026-10-11")).toBe("name,email,amount,currency,reference\r\n");
  });

  it("quotes commas, quotes and line breaks", () => {
    expect(csvField("Plain Name")).toBe("Plain Name");
    expect(csvField("Villarino, Marjorie")).toBe('"Villarino, Marjorie"');
    expect(csvField('Dan "The Man" Lee')).toBe('"Dan ""The Man"" Lee"');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField(" padded ")).toBe('" padded "');
    const csv = buildWiseCsv([{ name: 'Lee, Dan "DJ"', email: "dan@example.test", total: 12.345, status: "approved" }], "2026-10-04");
    expect(csv.split("\r\n")[1]).toBe('"Lee, Dan ""DJ""",dan@example.test,12.35,USD,Genexa week ending 04 Oct');
  });

  it("keeps a person with no email in the file with a blank email", () => {
    const csv = buildWiseCsv([{ name: "No Email", email: null, total: 10, status: "approved" }], "2026-10-11");
    expect(csv.split("\r\n")[1]).toBe("No Email,,10.00,USD,Genexa week ending 11 Oct");
  });

  it("writes the reference from the week end", () => {
    expect(wiseReference("2026-10-11")).toBe("Genexa week ending 11 Oct");
    expect(wiseReference("2027-01-03")).toBe("Genexa week ending 03 Jan");
  });
});

describe("pay weeks", () => {
  it("start on Monday", () => {
    expect(weekStartOf("2026-10-05")).toBe("2026-10-05"); // Monday
    expect(weekStartOf("2026-10-07")).toBe("2026-10-05"); // Wednesday
    expect(weekStartOf("2026-10-11")).toBe("2026-10-05"); // Sunday
    expect(weekStartOf("2027-01-01")).toBe("2026-12-28"); // across a year end
  });
  it("the job builds the week ending on the coming Sunday, or today if today is Sunday", () => {
    expect(payRunWeek("2026-10-07")).toBe("2026-10-05");
    expect(payRunWeek("2026-10-11")).toBe("2026-10-05");
    expect(payRunWeek("2026-10-12")).toBe("2026-10-12");
  });
  it("the page opens on the week ending today, otherwise the one that just ended", () => {
    expect(defaultPayWeek("2026-10-11")).toBe("2026-10-05"); // Sunday: the week ending today
    expect(defaultPayWeek("2026-10-12")).toBe("2026-10-05"); // Monday: last week
    expect(defaultPayWeek("2026-10-17")).toBe("2026-10-05"); // Saturday: still last week
  });
  it("recognises dates", () => {
    expect(isDate("2026-10-05")).toBe(true);
    expect(isDate("2026-13-45")).toBe(false);
    expect(isDate("next week")).toBe(false);
    expect(isDate(undefined)).toBe(false);
  });
});

describe("payroll formatting", () => {
  it("always shows cents and keeps null as null", () => {
    expect(usd(1234.5)).toBe("$1,234.50");
    expect(usd(0)).toBe("$0.00");
    expect(usd(-20)).toBe("-$20.00");
    expect(usd(null)).toBeNull();
  });
  it("formats a day and month", () => {
    expect(dayMonth("2026-10-04")).toBe("04 Oct");
  });
});
