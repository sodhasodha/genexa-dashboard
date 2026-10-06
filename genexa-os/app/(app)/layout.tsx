import { Sidebar } from "@/components/Sidebar";
import { FreshnessBar } from "@/components/FreshnessBar";
import { NAV } from "@/lib/auth/nav";
import { requireStaff } from "@/lib/auth/staff";
import { getSourceFreshness } from "@/lib/queries/freshness";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const staff = await requireStaff();
  const sources = await getSourceFreshness();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Sidebar items={NAV} userName={staff.name} userRole={staff.role} />
      <div className="flex min-w-0 flex-1 flex-col md:h-screen md:overflow-y-auto">
        <FreshnessBar sources={sources} />
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
