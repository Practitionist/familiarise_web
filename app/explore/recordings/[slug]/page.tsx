import Image from "next/image";
import { notFound } from "next/navigation";
import { CheckCircle2, Clock, PlayCircle, ShieldCheck } from "lucide-react";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import {
  getPublicRecordingBySlug,
  type RecordingListing,
} from "@/lib/data/recordings-explore";
import { RecordingService } from "@/lib/stream/recording-service";
import {
  hiddenFromLateJoiner,
  lateJoinRecordingAccess,
} from "@/lib/stream/late-join-recordings";
import { getBestRecordingUrl } from "@/lib/stream/recording-storage";
import { formatCurrencyAmount } from "@/utils/formatting";
import { Badge } from "@/components/ui/badge";
import { buildCaptionTrackDataUri } from "@/components/recordings/caption-track";
import { RecordingBuyButton } from "./RecordingBuyButton";

type RecordingAccessRow = {
  status: string;
  storagePath: string | null;
  recordingUrl: string | null;
  meeting?: {
    occurrence?: {
      startsAt: Date;
      appointment?: {
        classId: string | null;
        class?: { classPlanId: string } | null;
      } | null;
    } | null;
  } | null;
};

async function canUserWatchRecording(
  userId: string,
  consultantProfileId: string | null | undefined,
  listing: RecordingListing,
  recording: RecordingAccessRow | null,
): Promise<boolean> {
  if (
    consultantProfileId &&
    listing.consultant.profileId === consultantProfileId
  ) {
    return true;
  }

  const purchase = await prisma.recordingPurchase.findFirst({
    where: {
      recordingId: listing.id,
      buyerId: userId,
      status: "SUCCEEDED",
    },
    select: { id: true },
  });
  if (purchase) {
    return true;
  }

  const { webinarPlanIds, classPlanIds } =
    await RecordingService.getPaidPlanIds(userId);
  if (
    listing.planType === "WEBINAR" &&
    webinarPlanIds.includes(listing.planId)
  ) {
    return true;
  }
  if (listing.planType === "CLASS" && classPlanIds.includes(listing.planId)) {
    const lateJoin = await lateJoinRecordingAccess(userId);
    return !hiddenFromLateJoiner(recording ?? {}, lateJoin);
  }

  return false;
}

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

  const session = await getSession(true);
  const rawRecording = session?.user?.id
    ? await prisma.recording.findUnique({
        where: { id: listing.id },
        select: {
          status: true,
          storagePath: true,
          recordingUrl: true,
          meeting: {
            select: {
              occurrence: {
                select: {
                  startsAt: true,
                  appointment: {
                    select: {
                      classId: true,
                      class: { select: { classPlanId: true } },
                    },
                  },
                },
              },
            },
          },
        },
      })
    : null;

  const alreadyAccess = session?.user?.id
    ? await canUserWatchRecording(
        session.user.id,
        session.user.consultantProfileId,
        listing,
        rawRecording,
      )
    : false;

  const fullPlaybackUrl =
    alreadyAccess && rawRecording
      ? await getBestRecordingUrl(rawRecording)
      : null;

  return (
    <div className="container mx-auto max-w-5xl px-4 py-10 grid gap-8 lg:grid-cols-[1.6fr_1fr]">
      <div className="space-y-6">
        <div className="relative aspect-video rounded-xl bg-muted flex items-center justify-center overflow-hidden">
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
            <details className="rounded-lg border bg-card/50 p-4">
              <summary className="cursor-pointer text-sm font-medium">
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
        {alreadyAccess ? (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>Full Recording Unlocked — you already own this replay.</span>
          </div>
        ) : (
          <RecordingBuyButton
            recordingId={listing.id}
            listPricePaise={listing.listPricePaise}
            formattedPrice={formatCurrencyAmount(listing.listPricePaise, "INR")}
          />
        )}
        <ul className="space-y-2 pt-2 text-xs text-muted-foreground">
          <li className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> Lifetime access via your
            dashboard
          </li>
          <li className="flex items-center gap-2">
            <PlayCircle className="h-4 w-4" /> Secure streaming — links expire
            hourly
          </li>
        </ul>
      </aside>
    </div>
  );
}
