import Link from "next/link";
import { PlayCircle } from "lucide-react";

import { EmptyState } from "@/components/dashboard/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { RecordingListing } from "@/lib/data/recordings-explore";
import { formatCurrencyAmount } from "@/utils/formatting";

/** The expert's recordings listed for sale; listing happens from Studio. */
export function HostedReplays({
  consultantId,
  replays,
}: Readonly<{ consultantId: string; replays: readonly RecordingListing[] }>) {
  const studioHref = `/dashboard/consultant/${consultantId}/recordings`;
  if (replays.length === 0) {
    return (
      <EmptyState
        icon={PlayCircle}
        title="No replays on sale"
        description="A replay is a recording of a session you hosted, listed for sale. Your recordings are in Studio."
        action={
          <Button asChild size="sm" variant="outline">
            <Link href={studioHref}>Open Studio › Recordings</Link>
          </Button>
        }
      />
    );
  }
  return (
    <div className="space-y-4">
      <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {replays.map((replay) => (
          <li key={replay.id}>
            <Card className="h-full">
              <CardContent className="flex h-full flex-col gap-2 p-4">
                <p className="line-clamp-2 font-medium">
                  {replay.listingTitle}
                </p>
                <p className="text-sm text-muted-foreground">
                  {replay.planTitle} · {replay.durationInMinutes}m
                </p>
                <p className="mt-auto font-semibold">
                  {formatCurrencyAmount(replay.listPricePaise, "INR")}
                </p>
                {replay.slug && (
                  <Link
                    href={`/explore/recordings/${replay.slug}`}
                    className="text-sm text-primary hover:underline"
                  >
                    View public page
                  </Link>
                )}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      <Link
        href={studioHref}
        className="inline-block text-sm text-muted-foreground hover:text-foreground hover:underline"
      >
        Manage recordings in Studio
      </Link>
    </div>
  );
}
