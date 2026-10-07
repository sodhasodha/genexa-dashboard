"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { NavGroup } from "@/lib/auth/nav";

export function Sidebar({ groups, userName, userRole }: { groups: NavGroup[]; userName: string; userRole: string }) {
  const pathname = usePathname();
  const period = useSearchParams().get("period");
  const isActive = (href: string) => {
    const [path, query] = href.split("?");
    if (pathname !== path && !pathname.startsWith(`${path}/`)) return false;
    const want = query ? new URLSearchParams(query).get("period") : null;
    return path === "/overview" ? want === period : true;
  };
  return (
    <aside className="flex shrink-0 flex-col border-line bg-panel md:h-screen md:w-52 md:overflow-y-auto md:border-r max-md:border-b">
      <div className="px-4 py-3 text-sm font-semibold tracking-tight">Genexa OS</div>
      <nav className="flex gap-3 overflow-x-auto px-2 pb-2 md:flex-col md:gap-4 md:overflow-visible">
        {groups.map((group) => (
          <div key={group.title} className="flex shrink-0 gap-0.5 md:flex-col">
            <div className="hidden px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted md:block">{group.title}</div>
            {group.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`whitespace-nowrap rounded px-2 py-1.5 text-sm ${isActive(item.href) ? "bg-raised font-medium text-ink" : "text-muted hover:bg-raised hover:text-ink"}`}
              >
                {item.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className="mt-auto hidden border-t border-line px-4 py-3 text-xs md:block">
        <div className="font-medium">{userName}</div>
        <div className="text-muted">{userRole.replace("_", " ")}</div>
        <div className="mt-2 flex gap-3">
          <Link href="/eod" className="underline">EOD</Link>
          <form action="/auth/signout" method="post">
            <button type="submit" className="cursor-pointer underline">Sign out</button>
          </form>
        </div>
      </div>
    </aside>
  );
}
