import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth/staff";
import { buildReportPdf, reportFileName } from "@/lib/reports/pdf";
import { getReport, parseReportRange } from "@/lib/queries/reports";

// The one-page PDF for one clinic and one date range. Any signed-in staff member.
export async function GET(request: NextRequest, ctx: RouteContext<"/api/reports/[clientId]/pdf">) {
  await requireStaff();
  const { clientId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) return NextResponse.json({ error: "unknown clinic" }, { status: 404 });
  const range = parseReportRange(Object.fromEntries(request.nextUrl.searchParams));
  const row = await getReport(clientId, range);
  if (!row) return NextResponse.json({ error: "unknown clinic" }, { status: 404 });
  const pdf = await buildReportPdf({
    clinic: row.name, from: range.from, to: range.to,
    spend: row.spend ?? 0, leads: row.leads, booked: row.booked, shows: row.shows, closes: row.closes, revenue: row.revenue,
  });
  return new NextResponse(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${reportFileName(row.name, range.from, range.to)}"`,
      "Cache-Control": "no-store",
    },
  });
}
