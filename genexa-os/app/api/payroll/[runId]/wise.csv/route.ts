import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth/staff";
import { buildWiseCsv } from "@/lib/payroll/wise";
import { getPayLines, getPayRunById } from "@/lib/queries/payroll";

// The Wise batch file for one pay run. Owner only: requireOwner() sends anyone
// else away, and RLS returns them no payroll rows regardless.
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/payroll/[runId]/wise.csv">) {
  await requireOwner();
  const { runId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return NextResponse.json({ error: "unknown pay run" }, { status: 404 });
  const run = await getPayRunById(runId);
  if (!run) return NextResponse.json({ error: "unknown pay run" }, { status: 404 });
  const csv = buildWiseCsv(await getPayLines(run.id), run.week_end);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="genexa-wise-week-ending-${run.week_end}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
