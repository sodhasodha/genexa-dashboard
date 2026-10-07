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

/** ?tz=America/New_York&hour=23&dow=0 -> only run when it is that hour (and weekday, 0 = Sunday) in that timezone. */
function localTimeGate(params: URLSearchParams): { due: boolean; reason?: string } {
  const tz = params.get("tz");
  const hour = params.get("hour");
  if (!tz || hour === null) return { due: true };
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", weekday: "short" }).formatToParts(new Date());
  const localHour = Number(parts.find((p) => p.type === "hour")?.value);
  const localDow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((p) => p.type === "weekday")?.value ?? "");
  if (localHour !== Number(hour)) return { due: false, reason: `it is ${localHour}:00 in ${tz}, not ${hour}:00` };
  const dow = params.get("dow");
  if (dow !== null && localDow !== Number(dow)) return { due: false, reason: `wrong weekday in ${tz}` };
  return { due: true };
}

export async function POST(request: NextRequest, ctx: RouteContext<"/api/jobs/[job]">) {
  if (!authorised(request)) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const { job } = await ctx.params;
  // Jobs that belong to a local time (ET or UK) are scheduled at both UTC hours that
  // time can fall on; the run that is not at the right local hour stops here.
  const gate = localTimeGate(request.nextUrl.searchParams);
  if (!gate.due) return NextResponse.json({ job, ok: true, skipped: gate.reason });
  const run = JOBS[job];
  if (!run) return NextResponse.json({ error: `unknown job: ${job}` }, { status: 404 });
  try {
    const result = await run();
    return NextResponse.json({ job, ...result }, { status: result.ok ? 200 : 500 });
  } catch (err) {
    return NextResponse.json({ job, ok: false, error: (err as Error).message }, { status: 500 });
  }
}
