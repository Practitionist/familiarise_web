import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma, DocumentReviewStatus } from "@prisma/client";
import { resolveOrgScope, scopeOrgId } from "@/lib/api/scope/parse";

import { getSession } from "@/lib/auth-server";
import {
  buildRootThreadStatusWhere,
  groupDocumentsIntoThreads,
} from "@/lib/documents/document-review";

function parseUploadedByRole(
  rawRole: string | null,
): "CONSULTEE" | "CONSULTANT" | null {
  if (rawRole === "CONSULTANT") return "CONSULTANT";
  if (rawRole === "CONSULTEE") return "CONSULTEE";
  return null;
}

function resolveDocOrgFilter(
  scopeKind: string,
  scopedOrgId: string | null,
): Partial<Prisma.AppointmentWhereInput> {
  if (scopeKind === "personal") {
    return { organizationId: null };
  }
  if (scopedOrgId) {
    return { organizationId: scopedOrgId };
  }
  return {};
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ consultantId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to view documents for review",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    const { consultantId } = await params;

    if (!consultantId) {
      return NextResponse.json(
        {
          error: "Invalid consultant",
          message: "Consultant ID is required",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const appointmentType = searchParams.get("appointmentType");
    const uploadedByRoleFilter = parseUploadedByRole(
      searchParams.get("uploadedByRole"),
    );

    const DEFAULT_LIMIT = 10;
    const MAX_LIMIT = 100;

    const rawLimit = searchParams.get("limit");
    const rawOffset = searchParams.get("offset");

    const parsedLimit = rawLimit
      ? Number.parseInt(rawLimit, 10)
      : DEFAULT_LIMIT;
    const parsedOffset = rawOffset ? Number.parseInt(rawOffset, 10) : 0;

    if (
      !Number.isFinite(parsedLimit) ||
      parsedLimit < 1 ||
      parsedLimit > MAX_LIMIT
    ) {
      return NextResponse.json(
        {
          error: "Invalid limit",
          message: `"limit" must be an integer between 1 and ${MAX_LIMIT}.`,
          code: "INVALID_PAGINATION",
        },
        { status: 400 },
      );
    }

    if (!Number.isFinite(parsedOffset) || parsedOffset < 0) {
      return NextResponse.json(
        {
          error: "Invalid offset",
          message: `"offset" must be a non-negative integer.`,
          code: "INVALID_PAGINATION",
        },
        { status: 400 },
      );
    }

    const take = parsedLimit;
    const skip = parsedOffset;

    let consultant;
    try {
      const isDevelopment =
        process.env.NODE_ENV === "development" &&
        process.env.DEV_BYPASS_AUTH === "true";

      const consultantWhereClause: Prisma.ConsultantProfileWhereInput = {
        id: consultantId,
      };

      if (!isDevelopment) {
        consultantWhereClause.user = {
          id: session.user.id,
        };
      }

      consultant = await prisma.consultantProfile.findFirst({
        where: consultantWhereClause,
        include: {
          user: {
            select: { name: true, email: true },
          },
        },
      });
    } catch (dbError) {
      console.error("Database error fetching consultant:", dbError);
      Sentry.captureException(
        dbError instanceof Error ? dbError : new Error(String(dbError)),
        { tags: { subsystem: "dashboard" } },
      );
      return NextResponse.json(
        {
          error: "Database temporarily unavailable",
          message:
            "Unable to verify consultant access. Please try again in a few moments.",
          code: "DATABASE_ERROR",
        },
        { status: 503 },
      );
    }

    if (!consultant) {
      return NextResponse.json(
        {
          error: "Access denied",
          message:
            "You don't have permission to view documents for this consultant profile. Please check that you're accessing the correct consultant dashboard.",
          code: "ACCESS_DENIED",
        },
        { status: 403 },
      );
    }

    const callerMembershipsForScope = await prisma.membership.findMany({
      where: { userId: session.user.id, status: "ACTIVE" },
      select: {
        organizationId: true,
        status: true,
        role: true,
        organization: { select: { status: true } },
      },
    });
    const docScopeResolution = resolveOrgScope({
      raw: searchParams.get("orgScope"),
      memberships: callerMembershipsForScope,
      userRole: session.user.role,
      userId: session.user.id,
      allowAllForOwner: true,
    });
    if (!docScopeResolution.ok) {
      return NextResponse.json(
        {
          error: docScopeResolution.message,
          code: docScopeResolution.code,
        },
        { status: docScopeResolution.status },
      );
    }
    const docScopedOrgId = scopeOrgId(docScopeResolution.scope);
    const docOrgFilter = resolveDocOrgFilter(
      docScopeResolution.scope.kind,
      docScopedOrgId,
    );

    const terminalStatuses = ["CANCELLED", "REJECTED", "EXPIRED"] as const;

    const appointmentWhere: Prisma.AppointmentWhereInput = {
      OR: [
        {
          consultation: {
            consultationPlan: {
              consultantProfileId: consultantId,
            },
            status: { notIn: [...terminalStatuses] },
          },
        },
        {
          subscription: {
            subscriptionPlan: {
              consultantProfileId: consultantId,
            },
            status: { notIn: [...terminalStatuses] },
          },
        },
      ],
      ...docOrgFilter,
    };

    if (appointmentType) {
      const validTypes = ["Consultation", "Subscription"];
      if (!validTypes.includes(appointmentType)) {
        return NextResponse.json(
          {
            error: "Invalid appointment type filter",
            message: `Appointment type "${appointmentType}" is not valid. Valid types are: ${validTypes.join(", ")}`,
            code: "INVALID_FILTER",
          },
          { status: 400 },
        );
      }

      if (appointmentType === "Consultation") {
        appointmentWhere.consultation = { isNot: null };
        appointmentWhere.subscription = null;
      } else if (appointmentType === "Subscription") {
        appointmentWhere.subscription = { isNot: null };
        appointmentWhere.consultation = null;
      }
    }

    if (status) {
      const validStatuses = [
        "PENDING",
        "IN_REVIEW",
        "APPROVED",
        "REJECTED",
        "NEEDS_REVISION",
      ];
      if (!validStatuses.includes(status)) {
        return NextResponse.json(
          {
            error: "Invalid status filter",
            message: `Status "${status}" is not valid. Valid statuses are: ${validStatuses.join(", ")}`,
            code: "INVALID_FILTER",
          },
          { status: 400 },
        );
      }
    }

    const baseRootWhere: Prisma.AppointmentDocumentWhereInput = {
      deletedAt: null,
      rootDocumentId: null,
      ...(uploadedByRoleFilter && { uploadedByRole: uploadedByRoleFilter }),
      appointment: appointmentWhere,
    };

    const rootWhereWithStatus = buildRootThreadStatusWhere(
      baseRootWhere,
      status as DocumentReviewStatus | null,
    );

    let rootRows;
    let totalCount = 0;
    let metadataGrouped: Array<{
      reviewStatus: DocumentReviewStatus;
      _count: { _all: number };
    }>;

    try {
      [rootRows, totalCount, metadataGrouped] = await Promise.all([
        prisma.appointmentDocument.findMany({
          where: rootWhereWithStatus,
          include: {
            threadVersions: {
              where: { deletedAt: null },
              orderBy: { versionNo: "asc" },
            },
            appointment: {
              include: {
                consultation: {
                  include: {
                    requestedBy: { include: { user: true } },
                    consultationPlan: true,
                  },
                },
                subscription: {
                  include: {
                    requestedBy: { include: { user: true } },
                    subscriptionPlan: true,
                  },
                },
              },
            },
          },
          orderBy: { uploadedAt: "desc" },
          skip,
          take,
        }),
        prisma.appointmentDocument.count({
          where: rootWhereWithStatus,
        }),
        prisma.appointmentDocument.groupBy({
          by: ["reviewStatus"],
          where: {
            deletedAt: null,
            uploadedByRole: "CONSULTEE",
            appointment: appointmentWhere,
          },
          _count: { _all: true },
        }),
      ]);
    } catch (dbError) {
      console.error("Database error fetching documents:", dbError);
      Sentry.captureException(
        dbError instanceof Error ? dbError : new Error(String(dbError)),
        { tags: { subsystem: "dashboard" } },
      );

      return NextResponse.json({
        data: [],
        count: 0,
        message: "Unable to load documents at the moment.",
        consultant: consultant.user.name,
        filters: {
          status,
          appointmentType,
          uploadedByRole: uploadedByRoleFilter,
        },
        pagination: {
          limit: take,
          offset: skip,
          totalCount: 0,
          totalPages: 1,
          currentPage: 1,
          hasNextPage: false,
          hasPrevPage: false,
        },
        metadata: {
          pendingCount: 0,
          reviewingCount: 0,
          needsRevisionCount: 0,
          completedCount: 0,
        },
      });
    }

    const flattenedRows = rootRows.flatMap((rootDoc) => {
      const appointment = rootDoc.appointment;
      const consultation = appointment.consultation;
      const subscription = appointment.subscription;

      let clientName = "Unknown Client";
      let clientId = "";
      let appointmentTitle = "Unknown Appointment";
      let resolvedAppointmentType = "Unknown";

      if (consultation) {
        clientName = consultation.requestedBy?.user?.name || "Unknown Client";
        clientId = consultation.requestedBy?.user?.id || "";
        appointmentTitle =
          consultation.consultationPlan?.title || "Consultation";
        resolvedAppointmentType = "Consultation";
      } else if (subscription) {
        clientName = subscription.requestedBy?.user?.name || "Unknown Client";
        clientId = subscription.requestedBy?.user?.id || "";
        appointmentTitle =
          subscription.subscriptionPlan?.title || "Subscription";
        resolvedAppointmentType = "Subscription";
      }

      const rawVersions = [rootDoc, ...rootDoc.threadVersions];
      return rawVersions.map((doc) => ({
        id: doc.id,
        appointmentId: doc.appointmentId,
        fileName: doc.fileName,
        originalName: doc.originalName,
        fileSize: doc.fileSize,
        mimeType: doc.mimeType,
        fileUrl: doc.fileUrl,
        description: doc.description,
        reviewStatus: doc.reviewStatus,
        reviewNotes: doc.reviewNotes,
        reviewedAt: doc.reviewedAt,
        uploadedByRole: doc.uploadedByRole,
        versionNo: doc.versionNo,
        rootDocumentId: doc.rootDocumentId,
        responseToDocumentId: doc.responseToDocumentId,
        uploadedAt: doc.uploadedAt,
        clientName,
        clientId,
        appointmentTitle,
        appointmentType: resolvedAppointmentType,
        title: rootDoc.originalName,
        tag: doc.reviewStatus,
      }));
    });

    const pageThreads = groupDocumentsIntoThreads(flattenedRows);
    const filteredThreads = status
      ? pageThreads.filter((thread) => thread.effectiveStatus === status)
      : pageThreads;
    const pagedDocuments = filteredThreads.flatMap((thread) => thread.versions);

    const countByStatus = new Map<DocumentReviewStatus, number>(
      metadataGrouped.map((row) => [row.reviewStatus, row._count._all]),
    );
    const metadata = {
      pendingCount: countByStatus.get("PENDING") ?? 0,
      reviewingCount: countByStatus.get("IN_REVIEW") ?? 0,
      needsRevisionCount: countByStatus.get("NEEDS_REVISION") ?? 0,
      completedCount:
        (countByStatus.get("APPROVED") ?? 0) +
        (countByStatus.get("REJECTED") ?? 0),
    };

    const pluralSuffix = totalCount === 1 ? "" : "s";
    const message =
      totalCount === 0
        ? "No documents found for the current filters."
        : `Found ${totalCount} document thread${pluralSuffix}.`;

    return NextResponse.json({
      data: pagedDocuments,
      count: totalCount,
      message,
      consultant: consultant.user.name,
      filters: {
        status,
        appointmentType,
        uploadedByRole: uploadedByRoleFilter,
      },
      pagination: {
        limit: take,
        offset: skip,
        totalCount,
        totalPages: Math.max(1, Math.ceil(totalCount / take)),
        currentPage: Math.floor(skip / take) + 1,
        hasNextPage: skip + take < totalCount,
        hasPrevPage: skip > 0,
      },
      metadata,
    });
  } catch (error) {
    console.error("Error fetching consultant documents:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "dashboard" } },
    );

    return NextResponse.json(
      {
        error: "Unable to load documents",
        message:
          "Something went wrong while loading documents for review. Please refresh the page or try again later.",
        code: "UNKNOWN_ERROR",
      },
      { status: 500 },
    );
  }
}
