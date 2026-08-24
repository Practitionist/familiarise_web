/**
 * Recording Listing Publish API (#366 curated recordings marketplace)
 * POST   /api/stream/recordings/[recordingId]/publish — publish to /explore/recordings
 * DELETE /api/stream/recordings/[recordingId]/publish — unpublish (keeps copy for re-publish)
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import {
  guardOwnedListingRecording,
  isDiscoverablePlanPlan,
} from "@/lib/stream/recording-listing-access";

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
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "Lowercase letters, digits, dashes")
    .min(3)
    .max(80)
    .optional(),
  /** Explicit redistribution-consent attestation — required, audit-logged. */
  consentAttested: z.literal(true),
});

function buildSlug(title: string, id: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "recording"}-${id.slice(-6).toLowerCase()}`;
}

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!session.user.consultantProfileId) {
      return NextResponse.json(
        { error: "Only consultants can publish recordings" },
        { status: 403 },
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body", code: "INVALID_INPUT" },
        { status: 400 },
      );
    }
    const parsed = PublishSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid input",
          details: parsed.error.issues,
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
    }
    const { listingTitle, listingDescription, listPricePaise, tags, slug } =
      parsed.data;

    const { recordingId } = await params;
    const guard = await guardOwnedListingRecording(recordingId);
    if (!guard.ok) return guard.response;
    const loaded = guard.loaded;

    // A sold replay must outlive any single session: Stream URLs die ≤14d.
    if (loaded.recordingStatus !== "AVAILABLE" || loaded.storageType !== "SUPABASE") {
      return NextResponse.json(
        {
          error:
            "Only permanently stored (premium plan) recordings can be published.",
          code: "STORAGE_POLICY",
        },
        { status: 400 },
      );
    }

    // Org visibility + live-plan gate — same predicate the purchase route
    // enforces before minting an order.
    if (!isDiscoverablePlanPlan(loaded.plan.plan)) {
      return NextResponse.json(
        {
          error:
            "This recording's plan is archived or its organization limits visibility.",
          code: loaded.plan.plan.archivedAt ? "PLAN_ARCHIVED" : "ORG_VISIBILITY",
        },
        { status: 403 },
      );
    }

    const finalSlug = slug ?? buildSlug(listingTitle, loaded.recordingId);
    const slugClash = await prisma.recording.findUnique({
      where: { slug: finalSlug },
      select: { id: true },
    });
    if (slugClash && slugClash.id !== loaded.recordingId) {
      return NextResponse.json(
        { error: "That link is taken — pick another.", code: "SLUG_TAKEN" },
        { status: 409 },
      );
    }

    let updated;
    try {
      updated = await prisma.recording.update({
        where: { id: loaded.recordingId },
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
        },
        select: { id: true, slug: true, listingStatus: true, publishedAt: true },
      });
    } catch (updateError) {
      // Two concurrent publishes can pass the pre-check above; the @unique
      // constraint is the real gate. Surface it as a 409, not a 500.
      if (
        typeof updateError === "object" &&
        updateError !== null &&
        (updateError as { code?: string }).code === "P2002"
      ) {
        return NextResponse.json(
          { error: "That link is taken — pick another.", code: "SLUG_TAKEN" },
          { status: 409 },
        );
      }
      throw updateError;
    }

    // ISR hygiene (#1244 review): stale explore cards must not outlive an
    // unpublish elsewhere; revalidate both surfaces at the write site.
    revalidatePath("/explore/recordings");
    if (updated.slug) revalidatePath(`/explore/recordings/${updated.slug}`);

    return NextResponse.json({ data: updated }, { status: 201 });
  } catch (error) {
    console.error("Error publishing recording:", error);
    return NextResponse.json(
      { error: "Failed to publish recording" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: RouteParams,
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { recordingId } = await params;
    const guard = await guardOwnedListingRecording(recordingId);
    if (!guard.ok) return guard.response;
    const loaded = guard.loaded;

    const updated = await prisma.recording.update({
      where: { id: recordingId },
      data: {
        listingStatus: "UNPUBLISHED",
        unpublishedAt: new Date(),
      },
      select: { id: true, listingStatus: true, slug: true },
    });

    // Take the replay off the public library immediately (ISR hygiene).
    revalidatePath("/explore/recordings");
    if (updated.slug) revalidatePath(`/explore/recordings/${updated.slug}`);

    return NextResponse.json({ data: updated });
  } catch (error) {
    console.error("Error unpublishing recording:", error);
    return NextResponse.json(
      { error: "Failed to unpublish recording" },
      { status: 500 },
    );
  }
}
