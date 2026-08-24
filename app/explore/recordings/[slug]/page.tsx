import { notFound } from "next/navigation";
import { Clock, PlayCircle, ShieldCheck } from "lucide-react";
import {
  getPublicRecordingBySlug,
  publicRecordingWhere,
} from "@/lib/data/recordings-explore";
import prisma from "@/lib/prisma";
import { formatCurrencyAmount } from "@/utils/formatting";
import { RecordingBuyButton } from "./RecordingBuyButton";

// Dynamic by design (#932): the viewable gate reads the live row; a cached
// HTML could sell a recording that was just unpublished.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const listing = await getPublicRecordingBySlug(slug);
  if (!listing) return { title: "Recording not found" };
  return {
    title: `${listing.listingTitle} | Familiarise Recordings`,
    description:
      listing.listingDescription ??
      `Recorded ${listing.planType.toLowerCase()} by ${listing.consultant.name ?? "a consultant"}.`,
  };
}

function renderMedia(listing: {
  previewClipUrl: string | null;
  thumbnailUrl: string | null;
  listingTitle: string;
}) {
  if (listing.previewClipUrl) {
    return (
      <video
        src={listing.previewClipUrl}
        poster={listing.thumbnailUrl ?? undefined}
        controls
        preload="metadata"
        className="h-full w-full object-cover"
      />
    );
  }
  if (listing.thumbnailUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={listing.thumbnailUrl}
        alt={listing.listingTitle}
        className="h-full w-full object-cover"
      />
    );
  }
  return <PlayCircle className="h-16 w-16 text-muted-foreground/40" />;
}

export default async function RecordingDetailPage({
  params,
}: {
  readonly params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const listing = await getPublicRecordingBySlug(slug);
  if (!listing) notFound();

  // Preview clip presence check happens against the live gate too — an
  // unpublish between list render and detail render must 404 here.
  const stillListed = await prisma.recording.findFirst({
    where: { ...publicRecordingWhere(), id: listing.id },
    select: { id: true },
  });
  if (!stillListed) notFound();

  return (
    <div className="container mx-auto max-w-5xl px-4 py-10 grid gap-8 lg:grid-cols-[1.6fr_1fr]">
      <div className="space-y-6">
        <div className="aspect-video rounded-xl bg-muted flex items-center justify-center overflow-hidden">
          {renderMedia(listing)}
        </div>

        <div className="space-y-3">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            {listing.planType} replay · <Clock className="inline h-3 w-3" />{" "}
            {listing.durationInMinutes} min
          </span>
          <h1 className="text-2xl font-bold tracking-tight">
            {listing.listingTitle}
          </h1>
          <p className="text-sm text-muted-foreground">
            From “{listing.planTitle}” · recorded{" "}
            {new Date(listing.recordedAt).toLocaleDateString("en-IN", {
              dateStyle: "medium",
            })}
          </p>
          {listing.listingDescription && (
            <p className="whitespace-pre-line text-sm leading-relaxed">
              {listing.listingDescription}
            </p>
          )}
        </div>
      </div>

      <aside className="space-y-4 h-fit rounded-xl border bg-card p-6 lg:sticky lg:top-24">
        <p className="text-3xl font-bold">
          {formatCurrencyAmount(listing.listPricePaise, "INR")}
        </p>
        <RecordingBuyButton
          recordingId={listing.id}
          listPricePaise={listing.listPricePaise}
          formattedPrice={formatCurrencyAmount(
            listing.listPricePaise,
            "INR",
          )}
        />
        <ul className="space-y-2 pt-2 text-xs text-muted-foreground">
          <li className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> Lifetime access via your dashboard
          </li>
          <li className="flex items-center gap-2">
            <PlayCircle className="h-4 w-4" /> Secure streaming — links expire hourly
          </li>
        </ul>
      </aside>
    </div>
  );
}
