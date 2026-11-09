import Image from "next/image";
import Link from "next/link";
import { PlayCircle, Clock } from "lucide-react";
import { listPublicReplayCards } from "@/lib/data/recordings-explore";
import { withBuildTimeRetry } from "@/lib/data/fail-open";
import { buyerPriceLabelInr } from "@/lib/payments/pricing/display-price";
import { isPlatformGstRegistered } from "@/lib/pdf/supplier";
import { planTypeLabel } from "@/lib/labels/plan-labels";

export async function ReplaysGrid() {
  // A failing read reaches the error boundary; the listing never degrades to empty.
  const items = await withBuildTimeRetry(() => listPublicReplayCards(48));
  const gstRegistered = isPlatformGstRegistered();

  if (items.length === 0) {
    return (
      <div className="py-24 text-center text-muted-foreground">
        <PlayCircle className="mx-auto mb-4 h-12 w-12 opacity-40" />
        <p className="text-lg font-medium">Replays aren&apos;t on sale yet</p>
        <p className="mt-1 text-sm">
          Attendees can watch their session recordings from their dashboard.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {items.map((rec) => (
        <Link
          key={rec.id}
          href={
            rec.slug
              ? `/explore/recordings/${rec.slug}`
              : "/explore/products?tab=replays"
          }
          className="group rounded-xl border bg-card overflow-hidden hover:shadow-md transition-shadow"
        >
          <div className="aspect-video relative bg-muted">
            {rec.thumbnailUrl ? (
              // `unoptimized`: the thumbnail host is not allow-listed in
              // next.config, so the image is served as-is.
              <Image
                src={rec.thumbnailUrl}
                alt={rec.listingTitle}
                fill
                unoptimized
                className="object-cover"
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <PlayCircle className="h-10 w-10 text-muted-foreground/50" />
              </div>
            )}
            <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {rec.durationInMinutes}m
            </span>
          </div>
          <div className="p-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {planTypeLabel(rec.planType)}
              </span>
              <span className="font-semibold text-primary">
                {buyerPriceLabelInr(rec.listPricePaise, gstRegistered)}
              </span>
            </div>
            <h3 className="line-clamp-2 text-sm font-medium group-hover:text-primary transition-colors">
              {rec.listingTitle}
            </h3>
            <p className="text-xs text-muted-foreground truncate">
              {rec.consultant.name}
              {rec.consultant.headline ? ` · ${rec.consultant.headline}` : ""}
            </p>
          </div>
        </Link>
      ))}
    </div>
  );
}
