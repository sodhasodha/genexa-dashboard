import Link from "next/link";
import { ReviewList } from "@/components/overview/NeedsAction";
import { requireStaff } from "@/lib/auth/staff";
import { REVIEW_KINDS, getClientOptions, getReview } from "@/lib/queries/overview";

export default async function DataReviewPage({ searchParams }: PageProps<"/data-review">) {
  const me = await requireStaff();
  const params = await searchParams;
  const [review, clients] = await Promise.all([getReview(), getClientOptions()]);
  const queue = REVIEW_KINDS.find((k) => k.kind === params.queue)?.kind ?? REVIEW_KINDS.find((k) => review.counts[k.kind] > 0)?.kind ?? "anomaly";
  return (
    <div className="flex flex-col gap-3 p-4">
      <div>
        <h1 className="text-lg font-semibold">Data review</h1>
        <p className="text-xs text-muted">Records that need a person, so the numbers stay clean. {review.total} open.</p>
      </div>
      <div className="flex flex-wrap gap-1">
        {REVIEW_KINDS.map((k) => (
          <Link key={k.kind} href={`/data-review?queue=${k.kind}`} className={`rounded-md px-3 py-1.5 text-xs ${queue === k.kind ? "bg-raised font-medium text-ink" : "text-muted hover:text-ink"}`}>
            {k.label} <span className={review.counts[k.kind] > 0 ? "text-warn" : "text-muted"}>{review.counts[k.kind]}</span>
          </Link>
        ))}
      </div>
      <div className="rounded-lg border border-line bg-panel">
        <ReviewList items={review.items.filter((i) => i.kind === queue)} clients={clients} isOwner={me.role === "owner"} />
      </div>
    </div>
  );
}
