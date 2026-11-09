import Image from "next/image";
import Link from "next/link";

/** The desk's header: Confirmations and Hot Leads tabs, who is logged in, log out. */
export function DeskHeader({ me, active, hotWaiting, note }: { me: { name: string; role: string }; active: "confirmations" | "hot-leads"; hotWaiting: number; note: string }) {
  const tab = (key: typeof active, href: string, label: React.ReactNode) => (
    <Link href={href} aria-current={active === key ? "page" : undefined}
      className={`rounded-md px-3 py-1.5 text-sm ${active === key ? "bg-accent font-medium text-white" : "text-muted hover:bg-raised hover:text-ink"}`}>
      {label}
    </Link>
  );
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-line bg-panel px-4 py-2.5">
      <Image src="/logo.png" alt="" width={24} height={24} className="rounded-md" />
      <nav className="flex gap-1" aria-label="Desk">
        {tab("confirmations", "/confirmations", "Confirmations")}
        {tab("hot-leads", "/hot-leads", <>Hot Leads <span className="tabular-nums">({hotWaiting})</span></>)}
      </nav>
      <span className="text-xs text-muted">{note}</span>
      <div className="ml-auto flex items-center gap-3 text-sm">
        {me.role === "owner" ? <Link href="/overview" className="text-muted hover:text-ink">← Genexa OS</Link> : null}
        <span className="text-muted">{me.name}</span>
        <form action="/auth/signout" method="post">
          <button type="submit" className="cursor-pointer rounded border border-line px-2.5 py-1 text-xs hover:border-muted">Log out</button>
        </form>
      </div>
    </header>
  );
}
