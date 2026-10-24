/**
 * Recording Listing Publish API (#366 curated recordings marketplace)
 * POST   /api/stream/recordings/[recordingId]/publish — publish to /explore/recordings
 * DELETE /api/stream/recordings/[recordingId]/publish — unpublish (keeps copy for re-publish)
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import {
  guardOwnedListingRecording,
  isDiscoverablePlanPlan,
  resolvePreviewTranscript,
} from "@/lib/stream/recording-listing-access";
import { isDurablyOurs } from "@/lib/stream/recording-storage";
import {
  FileRouteError,
  answerFileRoute,
  fileApiError,
  parseJsonBody,
} from "@/lib/documents/api-error";

type RouteParams = { params: Promise<{ recordingId: string }> };

const PublishSchema = z.object({
  listingTitle: z.string().trim().min(3).max(120),
  listingDescription: z.string().trim().max(2000).optional(),
  // Paise, whole rupees minimum ₹1. Free listings are not supported in v1 —
  // a ₹0 "purchase" would mint entitlements without any payment trail.
  listPricePaise: z.number().int().min(100).max(100_000_000),
  tags: z.array(z.string().trim().min(1).max(30)).max(8).optional(),
  slug: z
    .string()
    .trim()
    .regex(
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
      "Lowercase letters, digits, dashes",
    )
    .min(3)
    .max(80)
    .optional(),
  /** Explicit redistribution-consent attestation — required, audit-logged. */
  consentAttested: z.literal(true),
  /**
   * #1244 review — text alternative for the preview clip. REQUIRED whenever a
   * preview clip exists (enforced in the handler, which can see the recording;
   * the schema cannot). A clip with speech and no text shuts out anyone who
   * relies on reading, and "the consultant will add one later" is not a gate.
   */
  previewTranscript: z.string().trim().min(1).max(20_000).optional(),
});

/**
 * A URL-safe slug for a published recording.
 *
 * Split-and-join rather than replace-and-trim. The previous form ended with
 * `.replace(/^-+|-+$/g, "")`, which SonarCloud flags as super-linear
 * (`typescript:S8786`) — an alternation of two greedy quantifiers, scanned
 * globally, is the shape that backtracks. It is the only Stream-owned
 * contributor to the failing `new_reliability_rating` on `dev`.
 *
 * Honestly: V8 optimises this particular pattern and a 40,000-dash input still
 * returns in under a millisecond, so this is a gate fix and a simplification
 * rather than a demonstrated denial of service. Worth taking anyway because it
 * is plainly linear and shorter.
 *
 * Splitting on runs of non-alphanumerics and dropping the empty pieces removes
 * the need to trim at all: `filter(Boolean)` discards the leading and trailing
 * fragments that produced the stray dashes. The one dash the 60-character cut
 * can still leave is stripped explicitly — at most one, because `join("-")`
 * over non-empty parts never produces two in a row.
 *
 * Verified byte-identical to the previous implementation across leading and
 * trailing punctuation, unicode, empty input, all-separator input, and titles
 * longer than the slice boundary.
 */
function buildSlug(title: string, id: string): string {
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let base = words.join("-").slice(0, 60);
  if (base.endsWith("-")) base = base.slice(0, -1);
  return `${base || "recording"}-${id.slice(-6).toLowerCase()}`;
}

type LoadedListing = Extract<
  Awaited<ReturnType<typeof guardOwnedListingRecording>>,
  { ok: true }
>["loaded"];

/** Durability, plan visibility and preview-transcript gates; throws the refusal, or returns the transcript to store. */
function checkPublishGates(
  loaded: LoadedListing,
  previewTranscript: string | undefined,
): { transcript: string | null } {
  // A sold replay must outlive any single session: Stream URLs die ≤14d.
  if (
    !isDurablyOurs({
      status: loaded.recordingStatus,
      storageType: loaded.storageType,
    }) ||
    !loaded.storagePath
  ) {
    throw new FileRouteError("STORAGE_POLICY");
  }
  // The purchase route enforces the same live-plan and visibility predicate.
  if (!isDiscoverablePlanPlan(loaded.plan.plan)) {
    throw new FileRouteError(
      loaded.plan.plan.archivedAt ? "PLAN_ARCHIVED" : "ORG_VISIBILITY",
    );
  }
  // Only the loaded recording knows whether a clip exists; a stored transcript satisfies re-publish.
  const transcriptGate = resolvePreviewTranscript({
    previewClipUrl: loaded.previewClipUrl,
    storedTranscript: loaded.previewTranscript,
    submittedTranscript: previewTranscript,
  });
  if (!transcriptGate.ok) {
    throw new FileRouteError("PREVIEW_TRANSCRIPT_REQUIRED");
  }
  return { transcript: transcriptGate.transcript };
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  return answerFileRoute(async () => {
    const session = await getSession();
    if (!session?.user?.id) return fileApiError("UNAUTHORIZED");
    if (!session.user.consultantProfileId) return fileApiError("FORBIDDEN");

    const {
      listingTitle,
      listingDescription,
      listPricePaise,
      tags,
      slug,
      previewTranscript,
    } = await parseJsonBody(request, PublishSchema);

    const { recordingId } = await params;
    const guard = await guardOwnedListingRecording(recordingId);
    if (!guard.ok) return fileApiError(guard.code);
    const loaded = guard.loaded;

    const gate = checkPublishGates(loaded, previewTranscript);

    const finalSlug = slug ?? buildSlug(listingTitle, loaded.recordingId);
    const slugClash = await prisma.recording.findUnique({
      where: { slug: finalSlug },
      select: { id: true },
    });
    if (slugClash && slugClash.id !== loaded.recordingId) {
      return fileApiError("SLUG_TAKEN");
    }

    let updated;
    try {
      // Retention and removal must win if they change the validated copy first.
      [updated] = await prisma.recording.updateManyAndReturn({
        where: {
          id: loaded.recordingId,
          status: "AVAILABLE",
          storageType: "PLATFORM",
          storagePath: loaded.storagePath,
          listingStatus: loaded.listingStatus,
          previewClipUrl: loaded.previewClipUrl,
          previewTranscript: loaded.previewTranscript,
        },
        data: {
          listingStatus: "PUBLISHED",
          listingTitle,
          listingDescription: listingDescription ?? null,
          listPricePaise: BigInt(listPricePaise),
          tags: tags ?? [],
          slug: finalSlug,
          publishedAt: new Date(),
          unpublishedAt: null,
          consentAttestedAt: new Date(),
          consentAttestedById: session.user.id,
          previewTranscript: gate.transcript,
        },
        select: {
          id: true,
          slug: true,
          listingStatus: true,
          publishedAt: true,
        },
      });
    } catch (updateError) {
      // Concurrent publishes can both pass the pre-check; the unique slug is the real gate.
      if (
        updateError instanceof Prisma.PrismaClientKnownRequestError &&
        updateError.code === "P2002"
      ) {
        return fileApiError("SLUG_TAKEN");
      }
      throw updateError;
    }

    if (!updated) return fileApiError("RECORDING_CHANGED");

    revalidatePath("/explore/recordings");
    if (updated.slug) revalidatePath(`/explore/recordings/${updated.slug}`);

    return NextResponse.json({ data: updated }, { status: 201 });
  }, "stream");
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  return answerFileRoute(async () => {
    const session = await getSession();
    if (!session?.user?.id) return fileApiError("UNAUTHORIZED");

    const { recordingId } = await params;
    const guard = await guardOwnedListingRecording(recordingId);
    if (!guard.ok) return fileApiError(guard.code);

    const updated = await prisma.recording.update({
      where: { id: recordingId },
      data: {
        listingStatus: "UNPUBLISHED",
        unpublishedAt: new Date(),
      },
      select: { id: true, listingStatus: true, slug: true },
    });

    // Take the replay off the public library immediately.
    revalidatePath("/explore/recordings");
    if (updated.slug) revalidatePath(`/explore/recordings/${updated.slug}`);

    return NextResponse.json({ data: updated });
  }, "stream");
}
