import Image from "next/image";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, Clock, PlayCircle } from "lucide-react";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { getPublicRecordingBySlug } from "@/lib/data/recordings-explore";
import { getBestRecordingUrl } from "@/lib/stream/recording-storage";
import { viewerPlaybackAccess } from "@/lib/stream/recording-slots";
import { Badge } from "@/components/ui/badge";
import { buildCaptionTrackDataUri } from "@/components/recordings/caption-track";

type RecordingAccessRow = {
  status: string;
  storagePath: string | null;
  recordingUrl: string | null;
  meeting: { occurrence: { appointmentId: string; ordinal: number } };
};

/** The same rule playback applies, so "unlocked" here always plays. */
async function canUserWatchRecording(
  userId: string,
  listingId: string,
  recording: RecordingAccessRow | null,
): Promise<boolean> {
  if (!recording) return false;
  const access = await viewerPlaybackAccess(userId, {
    id: listingId,
    appointmentId: recording.meeting.occurrence.appointmentId,
    ordinal: recording.meeting.occurrence.ordinal,
    expired: recording.status === "EXPIRED",
  });
  return access.allowed;
}

function renderMedia(
  listing: {
    previewClipUrl: string | null;
    previewTranscript: string | null;
    thumbnailUrl: string | null;
    listingTitle: string;
  },
  fullPlaybackUrl: string | null,
) {
  const playbackSrc = fullPlaybackUrl ?? listing.previewClipUrl;
  if (playbackSrc) {
    const trimmedPreviewTranscript = listing.previewTranscript?.trim() || null;
    const captionTrackSrc =
      !fullPlaybackUrl && trimmedPreviewTranscript
        ? buildCaptionTrackDataUri(trimmedPreviewTranscript)
        : null;
    return (
      <video
        src={playbackSrc}
        poster={listing.thumbnailUrl ?? undefined}
        controls
        preload="metadata"
        controlsList="nodownload"
        className="h-full w-full object-cover"
        aria-describedby={
          trimmedPreviewTranscript ? "preview-transcript" : undefined
        }
      >
        {captionTrackSrc && (
          <track
            kind="captions"
            srcLang="en"
            label="Transcript"
            src={captionTrackSrc}
            default
          />
        )}
      </video>
    );
  }
  if (listing.thumbnailUrl) {
    return (
      <Image
        src={listing.thumbnailUrl}
        alt={listing.listingTitle}
        fill
        unoptimized
        className="object-cover"
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

  const session = await getSession();
  const rawRecording = session?.user?.id
    ? await prisma.recording.findUnique({
        where: { id: listing.id },
        select: {
          status: true,
          storagePath: true,
          recordingUrl: true,
          meeting: {
            select: {
              occurrence: { select: { appointmentId: true, ordinal: true } },
            },
          },
        },
      })
    : null;

  const alreadyAccess = session?.user?.id
    ? await canUserWatchRecording(session.user.id, listing.id, rawRecording)
    : false;

  const fullPlaybackUrl =
    alreadyAccess && rawRecording ? getBestRecordingUrl(rawRecording) : null;

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
              {listing.planType} replay ·{" "}
              <Clock className="inline h-3.5 w-3.5" />{" "}
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
              {listing.consultant.name
                ? ` · by ${listing.consultant.name}`
                : ""}
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-10 grid gap-8 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-6">
          <div className="relative aspect-video rounded-2xl border border-border bg-muted flex items-center justify-center overflow-hidden shadow-sm">
            {renderMedia(listing, fullPlaybackUrl)}
            {alreadyAccess && (
              <div className="absolute top-3 left-3">
                <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">
                  <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                  Full Recording Unlocked
                </Badge>
              </div>
            )}
          </div>

          {(listing.previewClipUrl || alreadyAccess) &&
            listing.previewTranscript && (
              <details className="rounded-xl border border-border bg-card p-4">
                <summary className="cursor-pointer text-sm font-medium text-foreground">
                  {alreadyAccess ? "Session transcript" : "Preview transcript"}
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
          {alreadyAccess ? (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
              <span>You can watch the full recording.</span>
            </div>
          ) : (
            <div className="space-y-1 rounded-lg border bg-muted/40 p-3">
              <p className="text-sm font-semibold">Coming soon</p>
              <p className="text-xs text-muted-foreground">
                Replays can&apos;t be bought yet. Attendees of the session can
                watch it from their dashboard.
              </p>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
