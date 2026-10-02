import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Clock, PlayCircle, ShieldCheck } from "lucide-react";
import { getPublicRecordingBySlug } from "@/lib/data/recordings-explore";
import { formatCurrencyAmount } from "@/utils/formatting";
import { RecordingBuyButton } from "./RecordingBuyButton";

// ISR, not force-dynamic. This page reads no session — the gate is the
// public listing filter (PUBLISHED + durably-ours + discoverable plan), which
// only changes on publish/unpublish events. A 120s window means an unpublish
// can stay buyable for up to two minutes; the purchase route re-checks the
// live gate before minting an order, so a stale shell can never sell a
// withdrawn replay. In exchange every repeat click is served off the CDN with
// no function invocation (and no cold-start lottery).
export const revalidate = 120;

// Slugs created after build render on demand, then join the ISR cache.
export const dynamicParams = true;

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
  previewTranscript: string | null;
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
        aria-describedby={
          listing.previewTranscript ? "preview-transcript" : undefined
        }
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

  return (
    <div className="min-h-screen bg-background">
      {/* Dark Editorial Hero Header */}
      <header className="bg-zinc-950 text-white border-b border-zinc-800">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-10 md:py-12 space-y-4">
          <Link
            href="/explore/recordings"
            className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Recordings
          </Link>
          <div className="space-y-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-medium uppercase tracking-wider text-zinc-300">
              {listing.planType} replay · <Clock className="inline h-3.5 w-3.5" />{" "}
              {listing.durationInMinutes} min
            </span>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-white">
              {listing.listingTitle}
            </h1>
            <p className="text-sm text-zinc-400">
              From &ldquo;{listing.planTitle}&rdquo; · recorded{" "}
              {new Date(listing.recordedAt).toLocaleDateString("en-IN", {
                dateStyle: "medium",
              })}
              {listing.consultant.name ? ` · by ${listing.consultant.name}` : ""}
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-10 grid gap-8 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-6">
          <div className="aspect-video rounded-2xl border border-border bg-muted flex items-center justify-center overflow-hidden shadow-sm">
            {renderMedia(listing)}
          </div>

          {listing.previewClipUrl && listing.previewTranscript && (
            <details className="rounded-xl border border-border bg-card p-4">
              <summary className="cursor-pointer text-sm font-medium text-foreground">
                Preview transcript
              </summary>
              <p
                id="preview-transcript"
                className="mt-3 whitespace-pre-line text-sm leading-relaxed text-muted-foreground"
              >
                {listing.previewTranscript}
              </p>
            </details>
          )}

          {listing.listingDescription && (
            <div className="rounded-2xl border border-border bg-card p-6 space-y-2">
              <h2 className="text-lg font-semibold text-foreground">
                About this recording
              </h2>
              <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                {listing.listingDescription}
              </p>
            </div>
          )}
        </div>

        <aside className="space-y-4 h-fit rounded-2xl border border-border bg-card p-6 shadow-sm lg:sticky lg:top-[calc(var(--maintenance-banner-height,0px)+var(--header-height,5rem)+1.5rem)]">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              On-Demand Access
            </p>
            <p className="mt-1 text-3xl font-bold text-foreground">
              {formatCurrencyAmount(listing.listPricePaise, "INR")}
            </p>
          </div>
          <RecordingBuyButton
            recordingId={listing.id}
            listPricePaise={listing.listPricePaise}
            formattedPrice={formatCurrencyAmount(listing.listPricePaise, "INR")}
          />
          <ul className="space-y-2 border-t border-border pt-4 text-xs text-muted-foreground">
            <li className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-600" /> Lifetime
              access via your dashboard
            </li>
            <li className="flex items-center gap-2">
              <PlayCircle className="h-4 w-4 text-muted-foreground" /> Secure
              streaming — links expire hourly
            </li>
          </ul>
        </aside>
      </main>
    </div>
  );
}
