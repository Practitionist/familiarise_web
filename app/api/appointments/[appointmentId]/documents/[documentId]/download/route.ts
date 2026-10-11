import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { isBookingTerminal } from "@/lib/appointments/terminal-status";
import { getSession } from "@/lib/auth-server";
import { isPreviewableMimeType } from "@/lib/documents/urls";
import { createSignedStorageUrl } from "@/lib/documents/storage-verify";

export async function GET(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ appointmentId: string; documentId: string }> },
) {
  try {
    const { appointmentId, documentId } = await params;

    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to download documents",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    const userId = session.user.id;
    const isDevelopment =
      process.env.NODE_ENV === "development" &&
      process.env.DEV_BYPASS_AUTH === "true";

    const appointmentWhereClause: Prisma.AppointmentWhereInput = {
      id: appointmentId,
    };

    const searchParams = new URL(request.url).searchParams;
    const disposition =
      searchParams.get("disposition") === "inline" ? "inline" : "attachment";

    if (!isDevelopment) {
      appointmentWhereClause.OR = [
        {
          consultation: {
            requestedBy: {
              user: { id: userId },
            },
          },
        },
        {
          consultation: {
            consultationPlan: {
              consultantProfile: {
                user: { id: userId },
              },
            },
          },
        },
        {
          subscription: {
            OR: [
              {
                requestedBy: {
                  user: { id: userId },
                },
              },
              {
                subscriptionPlan: {
                  consultantProfile: {
                    user: { id: userId },
                  },
                },
              },
            ],
          },
        },
        {
          webinar: {
            OR: [
              {
                webinarPlan: {
                  consultantProfile: { user: { id: userId } },
                },
              },
              {
                appointment: {
                  participants: {
                    some: {
                      userId,
                      status: { in: ["CONFIRMED", "ATTENDED"] },
                    },
                  },
                },
              },
            ],
          },
        },
        {
          class: {
            OR: [
              {
                classPlan: {
                  consultantProfile: { user: { id: userId } },
                },
              },
              {
                appointment: {
                  participants: {
                    some: {
                      userId,
                      status: { in: ["CONFIRMED", "ATTENDED"] },
                    },
                  },
                },
              },
            ],
          },
        },
      ];
    }

    const appointment = await prisma.appointment.findFirst({
      where: appointmentWhereClause,
      include: {
        consultation: { select: { status: true } },
        subscription: { select: { status: true } },
        webinar: { select: { status: true } },
        class: { select: { status: true } },
      },
    });

    if (!appointment) {
      return NextResponse.json(
        {
          error: "Appointment not found",
          message: isDevelopment
            ? "[DEV MODE] This appointment doesn't exist or you don't have access to it."
            : "This appointment doesn't exist or you don't have permission to access it.",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }

    if (isBookingTerminal(appointment)) {
      return NextResponse.json(
        {
          error: "Document unavailable",
          message: "This appointment is no longer active.",
          code: "APPOINTMENT_TERMINAL",
        },
        { status: 403 },
      );
    }

    const document = await prisma.appointmentDocument.findFirst({
      where: {
        id: documentId,
        appointmentId,
        deletedAt: null,
      },
    });

    if (!document) {
      return NextResponse.json(
        {
          error: "Document not found",
          message: isDevelopment
            ? `[DEV MODE] Document ${documentId} not found in appointment ${appointmentId}`
            : "The requested document was not found or you don't have permission to access it",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }

    if (document.isStorageMissing) {
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

    const previewable = isPreviewableMimeType(
      document.mimeType,
      document.originalName,
    );
    const effectiveDisposition =
      disposition === "inline" && previewable ? "inline" : "attachment";

    const signed = await createSignedStorageUrl({
      bucket: "documents",
      storagePath: document.storagePath,
      originalName: document.originalName,
      disposition: effectiveDisposition,
      expiresInSeconds: 60,
    });

    if (!signed.ok) {
      if (signed.code === "STORAGE_CONFIG_ERROR") {
        Sentry.captureException(
          new Error("Supabase admin client not configured"),
          { tags: { subsystem: "appointments" } },
        );
        return NextResponse.json(
          {
            error: "Storage configuration error",
            message:
              "Document storage is not properly configured on the server.",
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
          mimeType: document.mimeType,
          originalName: document.originalName,
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
    console.error("Document download error:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "appointments" } },
    );
    return NextResponse.json(
      {
        error: "Server error",
        message:
          "An unexpected error occurred while downloading the document. Please try again.",
        code: "SERVER_ERROR",
      },
      { status: 500 },
    );
  }
}
