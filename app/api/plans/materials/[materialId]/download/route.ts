import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { isPreviewableMimeType } from "@/lib/documents/urls";
import { createSignedStorageUrl } from "@/lib/documents/storage-verify";

const CLOSED_OR_UNPAID_BOOKING_STATUSES = [
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
  "PENDING",
] as const;

const PAID_PARTICIPANT_STATUSES = ["CONFIRMED", "ATTENDED"] as const;

async function fetchMaterialWithAccessContext(
  materialId: string,
  userId: string,
) {
  return prisma.planMaterial.findUnique({
    where: { id: materialId },
    include: {
      consultationPlan: {
        select: {
          id: true,
          organizationId: true,
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
          organizationId: true,
          consultantProfile: { select: { userId: true } },
          subscriptions: {
            where: {
              requestedBy: { user: { id: userId } },
              status: { notIn: [...CLOSED_OR_UNPAID_BOOKING_STATUSES] },
            },
            select: { id: true },
            take: 1,
          },
        },
      },
      webinarPlan: {
        select: {
          id: true,
          organizationId: true,
          consultantProfile: { select: { userId: true } },
          collaborators: {
            where: {
              status: "ACCEPTED",
              consultantProfile: { userId },
            },
            select: { id: true },
            take: 1,
          },
          webinars: {
            where: {
              status: { not: "CANCELLED" },
              appointment: {
                participants: {
                  some: {
                    userId,
                    status: { in: [...PAID_PARTICIPANT_STATUSES] },
                  },
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
          organizationId: true,
          consultantProfile: { select: { userId: true } },
          collaborators: {
            where: {
              status: "ACCEPTED",
              consultantProfile: { userId },
            },
            select: { id: true },
            take: 1,
          },
          classes: {
            where: {
              status: { not: "CANCELLED" },
              appointment: {
                participants: {
                  some: {
                    userId,
                    status: { in: [...PAID_PARTICIPANT_STATUSES] },
                  },
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
}

async function verifyMaterialDownloadAccess(
  material: NonNullable<
    Awaited<ReturnType<typeof fetchMaterialWithAccessContext>>
  >,
  userId: string,
  isDevelopment: boolean,
): Promise<boolean> {
  if (isDevelopment) return true;

  const ownerUserId =
    material.consultationPlan?.consultantProfile?.userId ||
    material.subscriptionPlan?.consultantProfile?.userId ||
    material.webinarPlan?.consultantProfile?.userId ||
    material.classPlan?.consultantProfile?.userId;
  if (ownerUserId === userId) return true;

  const hasCollaboratorAccess =
    Boolean(material.webinarPlan?.collaborators.length) ||
    Boolean(material.classPlan?.collaborators.length);
  if (hasCollaboratorAccess) return true;

  const hasLearnerAccess =
    Boolean(material.consultationPlan?.consultations.length) ||
    Boolean(material.subscriptionPlan?.subscriptions.length) ||
    Boolean(material.webinarPlan?.webinars.length) ||
    Boolean(material.classPlan?.classes.length);
  if (hasLearnerAccess) return true;

  const planOrganizationId =
    material.organizationId ||
    material.consultationPlan?.organizationId ||
    material.subscriptionPlan?.organizationId ||
    material.webinarPlan?.organizationId ||
    material.classPlan?.organizationId ||
    null;

  if (!planOrganizationId) return false;

  const [catalogAccess, opsAccess] = await Promise.all([
    requireOrgAccess(planOrganizationId, { permission: "catalog.manage" }),
    requireOrgAccess(planOrganizationId, { permission: "operations.read" }),
  ]);
  return !catalogAccess.error || !opsAccess.error;
}

/** Issues 60s presigned download/preview URLs for authorized plan materials (`Cache-Control: private, no-store`). */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ materialId: string }> },
) {
  try {
    const { materialId } = await params;
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to access plan materials",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    const userId = session.user.id;
    const searchParams = new URL(request.url).searchParams;
    const disposition =
      searchParams.get("disposition") === "attachment"
        ? "attachment"
        : "inline";

    const isDevelopment =
      process.env.NODE_ENV === "development" &&
      process.env.DEV_BYPASS_AUTH === "true";

    const material = await fetchMaterialWithAccessContext(materialId, userId);
    if (!material) {
      return NextResponse.json(
        { error: "Material not found", code: "NOT_FOUND" },
        { status: 404 },
      );
    }

    const allowed = await verifyMaterialDownloadAccess(
      material,
      userId,
      isDevelopment,
    );
    if (!allowed) {
      return NextResponse.json(
        { error: "Access denied", code: "FORBIDDEN" },
        { status: 403 },
      );
    }

    const previewable = isPreviewableMimeType(
      material.mimeType,
      material.originalName,
    );
    const effectiveDisposition =
      disposition === "inline" && previewable ? "inline" : "attachment";

    const signed = await createSignedStorageUrl({
      bucket: "documents",
      storagePath: material.storagePath,
      originalName: material.originalName,
      disposition: effectiveDisposition,
      expiresInSeconds: 60,
    });

    if (!signed.ok) {
      if (signed.code === "STORAGE_CONFIG_ERROR") {
        return NextResponse.json(
          {
            error: "Storage configuration error",
            code: "STORAGE_CONFIG_ERROR",
          },
          { status: 500 },
        );
      }

      return NextResponse.json(
        {
          error: "File unavailable",
          message:
            "This file is missing from storage. Upload a replacement version to restore access.",
          code: "STORAGE_MISSING",
        },
        { status: 404 },
      );
    }

    const wantsJson =
      searchParams.get("format") === "json" ||
      request.headers.get("accept")?.includes("application/json");

    if (wantsJson) {
      return NextResponse.json(
        {
          signedUrl: signed.signedUrl,
          mimeType: material.mimeType,
          originalName: material.originalName,
          previewable,
        },
        {
          status: 200,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    }

    return NextResponse.redirect(signed.signedUrl, {
      status: 302,
      headers: { "Cache-Control": "private, no-store" },
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
