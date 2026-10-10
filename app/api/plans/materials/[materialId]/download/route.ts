import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase";
import { getSession } from "@/lib/auth-server";
import { isPreviewableMimeType } from "@/lib/documents/urls";
import { liveParticipant } from "@/lib/booking/participants";

const CLOSED_OR_UNPAID_BOOKING_STATUSES = [
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
  "PENDING",
] as const;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ materialId: string }> },
) {
  try {
    const { materialId } = await params;
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to access plan materials",
        },
        { status: 401 },
      );
    }

    const userId = session.user.id;
    const disposition =
      request.nextUrl.searchParams.get("disposition") === "attachment"
        ? "attachment"
        : "inline";

    const isDevelopment =
      process.env.NODE_ENV === "development" &&
      process.env.DEV_BYPASS_AUTH === "true";

    const material = await prisma.planMaterial.findUnique({
      where: { id: materialId },
      include: {
        consultationPlan: {
          select: {
            id: true,
            consultantProfile: { select: { userId: true } },
            consultations: {
              where: {
                requestedBy: { user: { id: userId } },
                status: { notIn: [...CLOSED_OR_UNPAID_BOOKING_STATUSES] },
              },
              select: { id: true },
              take: 1,
            },
          },
        },
        subscriptionPlan: {
          select: {
            id: true,
            consultantProfile: { select: { userId: true } },
            subscriptions: {
              where: {
                requestedBy: { user: { id: userId } },
                status: { notIn: [...CLOSED_OR_UNPAID_BOOKING_STATUSES] },
              },
              select: { id: true },
              take: 1,
            },
            trials: {
              where: {
                consulteeProfile: { user: { id: userId } },
                status: { notIn: ["REJECTED", "CANCELLED"] },
              },
              select: { id: true },
              take: 1,
            },
          },
        },
        webinarPlan: {
          select: {
            id: true,
            consultantProfile: { select: { userId: true } },
            webinars: {
              where: {
                appointment: {
                  participants: {
                    some: liveParticipant(userId),
                  },
                },
              },
              select: { id: true },
              take: 1,
            },
          },
        },
        classPlan: {
          select: {
            id: true,
            consultantProfile: { select: { userId: true } },
            classes: {
              where: {
                appointment: {
                  participants: {
                    some: liveParticipant(userId),
                  },
                },
              },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
    });

    if (!material) {
      return NextResponse.json(
        { error: "Material not found", code: "NOT_FOUND" },
        { status: 404 },
      );
    }

    const ownerUserId =
      material.consultationPlan?.consultantProfile?.userId ||
      material.subscriptionPlan?.consultantProfile?.userId ||
      material.webinarPlan?.consultantProfile?.userId ||
      material.classPlan?.consultantProfile?.userId;

    const hasLearnerAccess =
      Boolean(material.consultationPlan?.consultations.length) ||
      Boolean(material.subscriptionPlan?.subscriptions.length) ||
      Boolean(material.subscriptionPlan?.trials.length) ||
      Boolean(material.webinarPlan?.webinars.length) ||
      Boolean(material.classPlan?.classes.length);

    if (!isDevelopment && ownerUserId !== userId && !hasLearnerAccess) {
      return NextResponse.json(
        { error: "Access denied", code: "FORBIDDEN" },
        { status: 403 },
      );
    }

    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Storage configuration error", code: "STORAGE_CONFIG_ERROR" },
        { status: 500 },
      );
    }

    const { data: fileData, error: downloadError } = await supabaseAdmin.storage
      .from("documents")
      .download(material.storagePath);

    if (downloadError || !fileData) {
      Sentry.captureException(
        downloadError instanceof Error
          ? downloadError
          : new Error(String(downloadError)),
        { tags: { subsystem: "plans" } },
      );
      return NextResponse.json(
        { error: "Download failed", code: "STORAGE_ERROR" },
        { status: 500 },
      );
    }

    const buffer = Buffer.from(await fileData.arrayBuffer());
    const effectiveDisposition =
      disposition === "inline" && isPreviewableMimeType(material.mimeType)
        ? "inline"
        : "attachment";

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": material.mimeType || "application/octet-stream",
        "Content-Disposition": `${effectiveDisposition}; filename="${encodeURIComponent(material.originalName)}"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
        "Content-Length": buffer.length.toString(),
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "plans" } },
    );
    return NextResponse.json(
      { error: "Server error", code: "SERVER_ERROR" },
      { status: 500 },
    );
  }
}
