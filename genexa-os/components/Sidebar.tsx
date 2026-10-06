"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavItem } from "@/lib/auth/nav";

export function Sidebar({ items, userName, userRole }: { items: NavItem[]; userName: string; userRole: string }) {
  const pathname = usePathname();
  return (
    <aside className="flex shrink-0 flex-col border-line bg-panel md:h-screen md:w-48 md:border-r max-md:border-b">
      <div className="px-4 py-3 text-sm font-semibold tracking-tight">Genexa OS</div>
      <nav className="flex gap-0.5 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible">
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`whitespace-nowrap rounded px-2 py-1.5 text-sm ${
                active ? "bg-ink text-white" : "text-ink hover:bg-canvas"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
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
