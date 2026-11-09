import Link from "next/link";

import { Button } from "@/components/ui/button";

/** Reviews still waiting for the expert's reply; nothing at all when there are none. */
export function ReviewsToReply({
  count,
  consultantId,
}: Readonly<{ count: number; consultantId: string }>) {
  if (count <= 0) return null;
  const text = `${count} ${count === 1 ? "review is" : "reviews are"} waiting for your reply`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-border bg-card px-4 py-3 shadow-elevation-1">
      <p className="min-w-0 flex-1 text-sm font-medium text-foreground">
        {text}
      </p>
      <Button asChild size="sm" variant="outline">
        <Link
          href={`/dashboard/consultant/${consultantId}/reviews?tab=needs-reply`}
          aria-label={`Reply: ${text}`}
        >
          Reply
        </Link>
      </Button>
    </div>
  );
}
