/**
 * Recording Listing Publish API (#366 curated recordings marketplace)
 * POST   /api/stream/recordings/[recordingId]/publish — publish to /explore/recordings
 * DELETE /api/stream/recordings/[recordingId]/publish — unpublish (keeps copy for re-publish)
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";

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
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, digits, dashes")
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
    const recording = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: {
        id: true,
        status: true,
        storageType: true,
        meetingSession: {
          select: {
            slotOfAppointment: {
              select: {
                appointment: {
                  select: {
                    consultation: {
                      select: { consultationPlanId: true },
                    },
                    subscription: {
                      select: { subscriptionPlanId: true },
                    },
                    webinar: {
                      select: {
                        webinarPlan: {
                          select: {
                            consultantProfileId: true,
                            organizationId: true,
                            visibility: true,
                            archivedAt: true,
                          },
                        },
                      },
                    },
                    class: {
                      select: {
                        classPlan: {
                          select: {
                            consultantProfileId: true,
                            organizationId: true,
                            visibility: true,
                            archivedAt: true,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!recording) {
      return NextResponse.json(
        { error: "Recording not found" },
        { status: 404 },
      );
    }

    const appointment =
      recording.meetingSession.slotOfAppointment.appointment;
    const plan =
      appointment.webinar?.webinarPlan ?? appointment.class?.classPlan;

    // Only group offerings can be resold. 1:1 consultations/subscriptions are
    // private by design (default-off recording policy) and must never reach
    // the marketplace even if a session was recorded in an org context.
    if (!plan) {
      return NextResponse.json(
        {
          error:
            "Only webinar and class recordings can be published to the library.",
          code: "NOT_LISTABLE",
        },
        { status: 400 },
      );
    }

    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });
    if (!consultantProfile || plan.consultantProfileId !== consultantProfile.id) {
      return NextResponse.json(
        { error: "Not authorized to publish this recording" },
        { status: 403 },
      );
    }

    // A sold replay must outlive any single session: Stream URLs die ≤14d.
    if (recording.status !== "AVAILABLE" || recording.storageType !== "SUPABASE") {
      return NextResponse.json(
        {
          error:
            "Only permanently stored (premium plan) recordings can be published.",
          code: "STORAGE_POLICY",
        },
        { status: 400 },
      );
    }

    // Org plans must opt into public discoverability.
    if (
      plan.organizationId &&
      !["PUBLIC", "ORG_AND_PUBLIC"].includes(plan.visibility)
    ) {
      return NextResponse.json(
        {
          error:
            "This plan's organization limits its visibility; publishing is disabled.",
          code: "ORG_VISIBILITY",
        },
        { status: 403 },
      );
    }
    if (plan.archivedAt) {
      return NextResponse.json(
        { error: "The parent plan has been withdrawn.", code: "PLAN_ARCHIVED" },
        { status: 400 },
      );
    }

    const finalSlug = slug ?? buildSlug(listingTitle, recording.id);
    const slugClash = await prisma.recording.findUnique({
      where: { slug: finalSlug },
      select: { id: true },
    });
    if (slugClash && slugClash.id !== recording.id) {
      return NextResponse.json(
        { error: "That link is taken — pick another.", code: "SLUG_TAKEN" },
        { status: 409 },
      );
    }

    const updated = await prisma.recording.update({
      where: { id: recording.id },
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
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });

    const recording = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: {
        meetingSession: {
          select: {
            slotOfAppointment: {
              select: {
                appointment: {
                  select: {
                    webinar: {
                      select: {
                        webinarPlan: { select: { consultantProfileId: true } },
                      },
                    },
                    class: {
                      select: {
                        classPlan: { select: { consultantProfileId: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!recording) {
      return NextResponse.json({ error: "Recording not found" }, { status: 404 });
    }

    const apt = recording.meetingSession.slotOfAppointment.appointment;
    const ownerId =
      apt.webinar?.webinarPlan?.consultantProfileId ??
      apt.class?.classPlan?.consultantProfileId;
    if (!ownerId || ownerId !== consultantProfile?.id) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }

    const updated = await prisma.recording.update({
      where: { id: recordingId },
      data: {
        listingStatus: "UNPUBLISHED",
        unpublishedAt: new Date(),
      },
      select: { id: true, listingStatus: true },
    });
    return NextResponse.json({ data: updated });
  } catch (error) {
    console.error("Error unpublishing recording:", error);
    return NextResponse.json(
      { error: "Failed to unpublish recording" },
      { status: 500 },
    );
  }
}
