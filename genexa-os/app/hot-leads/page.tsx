import { DeskHeader } from "@/components/confirmations/DeskHeader";
import { HotLeadList } from "@/components/confirmations/HotLeadList";
import { requireDeskUser } from "@/lib/auth/staff";
import { getHotLeads, waiting } from "@/lib/queries/hotLeads";

export const dynamic = "force-dynamic";

/** Hot Leads: who CSRs call when the confirmation queue is empty. Read from each clinic's GHL every 2 minutes. */
export default async function HotLeadsPage() {
  const me = await requireDeskUser();
  const rows = await getHotLeads();
  return (
    <div className="flex min-h-screen flex-col">
      <DeskHeader me={me} active="hot-leads" hotWaiting={waiting(rows)} note="Worth a call now, best first · click a name to open it in GHL · updates every 2 minutes" />
      <main className="flex flex-col gap-3 p-4">
        <HotLeadList rows={rows} />
      </main>
    </div>
  );
}
