import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { JOBS } from "@/lib/jobs/run";

// Scheduled jobs. Called by Supabase pg_cron with "Authorization: Bearer CRON_SECRET".
export const maxDuration = 300;

function authorised(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!secret || given.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

export async function POST(request: NextRequest, ctx: RouteContext<"/api/jobs/[job]">) {
  if (!authorised(request)) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const { job } = await ctx.params;
  const run = JOBS[job];
  if (!run) return NextResponse.json({ error: `unknown job: ${job}` }, { status: 404 });
  try {
    const result = await run();
    return NextResponse.json({ job, ...result }, { status: result.ok ? 200 : 500 });
  } catch (err) {
    return NextResponse.json({ job, ok: false, error: (err as Error).message }, { status: 500 });
  }
}
