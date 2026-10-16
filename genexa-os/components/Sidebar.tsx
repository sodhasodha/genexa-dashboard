"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { NavGroup } from "@/lib/auth/nav";

// Desktop: a fixed left sidebar. Phone: a sticky top bar showing the current page, with a Menu
// button that opens the same grouped navigation (plus EOD and Sign out).
export function Sidebar({ groups, userName, userRole }: { groups: NavGroup[]; userName: string; userRole: string }) {
  const pathname = usePathname();
  const period = useSearchParams().get("period");
  const [open, setOpen] = useState(false);
  const isActive = (href: string) => {
    const [path, query] = href.split("?");
    if (pathname !== path && !pathname.startsWith(`${path}/`)) return false;
    const want = query ? new URLSearchParams(query).get("period") : null;
    return path === "/overview" ? want === period : true;
  };
  const visible = groups.map((g) => ({ ...g, items: g.items.filter((item) => !item.ownerOnly || userRole === "owner") }));
  const current = visible.flatMap((g) => g.items).find((item) => isActive(item.href))?.label ?? (pathname === "/eod" ? "EOD" : "");
  return (
    <aside className="z-30 flex shrink-0 flex-col border-line bg-panel max-md:sticky max-md:top-0 max-md:border-b max-md:pt-[env(safe-area-inset-top)] md:h-screen md:w-52 md:overflow-y-auto md:border-r">
      <div className="flex items-center gap-2 px-4 py-2.5 text-sm font-semibold tracking-tight md:py-3">
        <Image src="/logo.png" alt="" width={24} height={24} className="rounded-md" />
        <span className="max-md:hidden">Genexa Operations</span>
        <span className="truncate md:hidden">{current || "Genexa Operations"}</span>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="main-nav"
          className="ml-auto cursor-pointer rounded border border-line px-3 py-1.5 text-xs font-medium text-muted md:hidden"
        >
          {open ? "Close" : "Menu"}
        </button>
      </div>
      <nav
        id="main-nav"
        className={`flex-col gap-4 px-2 pb-3 md:flex md:overflow-visible ${open ? "flex max-md:max-h-[calc(100dvh-3.5rem)] max-md:overflow-y-auto" : "hidden"}`}
      >
        {visible.map((group) => (
          <div key={group.title} className="flex flex-col">
            <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted">{group.title}</div>
            <div className="grid grid-cols-2 gap-0.5 md:flex md:flex-col">
              {group.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className={`whitespace-nowrap rounded px-2 py-2.5 text-sm md:py-1.5 ${isActive(item.href) ? "bg-raised font-medium text-ink" : "text-muted hover:bg-raised hover:text-ink"}`}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
        ))}
        <div className="flex items-center gap-3 border-t border-line px-2 pt-3 text-xs md:hidden">
          <span className="min-w-0 truncate">
            <span className="font-medium">{userName}</span> <span className="text-muted">· {userRole.replace("_", " ")}</span>
          </span>
          <Link href="/eod" onClick={() => setOpen(false)} className="ml-auto rounded border border-line px-3 py-2">EOD</Link>
          <form action="/auth/signout" method="post">
            <button type="submit" className="cursor-pointer rounded border border-line px-3 py-2">Sign out</button>
          </form>
        </div>
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
