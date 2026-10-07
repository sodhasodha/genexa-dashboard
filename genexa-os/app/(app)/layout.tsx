import { Suspense } from "react";
import { Sidebar } from "@/components/Sidebar";
import { FreshnessBar } from "@/components/FreshnessBar";
import { NAV_GROUPS } from "@/lib/auth/nav";
import { requireStaff } from "@/lib/auth/staff";
import { getSourceFreshness } from "@/lib/queries/freshness";
import { getMyAttendance } from "@/lib/queries/attendance";
import { ClockControl } from "@/components/attendance/ClockControl";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const staff = await requireStaff();
  const [sources, mine] = await Promise.all([getSourceFreshness(), getMyAttendance()]);
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Suspense>
        <Sidebar groups={NAV_GROUPS} userName={staff.name} userRole={staff.role} />
      </Suspense>
      <div className="flex min-w-0 flex-1 flex-col md:h-screen md:overflow-y-auto">
        {mine ? <ClockControl mine={mine} /> : null}
        <FreshnessBar sources={sources} />
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
