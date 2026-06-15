import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { uploadConsultantDocument } from "@/lib/supabase";
import { Prisma } from "@prisma/client";

import { getSession } from "@/lib/auth-server";
// Development mode check
const isDevelopment = () =>
  process.env.NODE_ENV === "development" &&
  process.env.DEV_BYPASS_AUTH === "true";

/**
 * POST - Upload a consultant response document
 * Consultant can upload documents as responses to consultee submissions
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to upload documents",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    const { appointmentId } = await params;
    const userId = session.user.id;

    // Build access control - verify user is the consultant for this appointment
    const appointmentWhereClause: Prisma.AppointmentWhereInput = {
      id: appointmentId,
    };

    if (!isDevelopment()) {
      appointmentWhereClause.OR = [
        // User is the consultant for consultation
        {
          consultation: {
            consultationPlan: {
              consultantProfile: {
                user: {
                  id: userId,
                },
              },
            },
          },
        },
        // User is the consultant for subscription
        {
          subscription: {
            subscriptionPlan: {
              consultantProfile: {
                user: {
                  id: userId,
                },
              },
            },
          },
        },
        // User is the consultant for webinar
        {
          webinar: {
            webinarPlan: {
              consultantProfile: {
                user: {
                  id: userId,
                },
              },
            },
          },
        },
        // User is the consultant for class
        {
          class: {
            classPlan: {
              consultantProfile: {
                user: {
                  id: userId,
                },
              },
            },
          },
        },
      ];
    }

    // Verify appointment exists and user is consultant
    const appointment = await prisma.appointment.findFirst({
      where: appointmentWhereClause,
      include: {
        consultation: {
          include: {
            consultationPlan: {
              include: {
                consultantProfile: {
                  select: { id: true, userId: true },
                },
              },
            },
          },
        },
        subscription: {
          include: {
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  select: { id: true, userId: true },
                },
              },
            },
          },
        },
        webinar: {
          include: {
            webinarPlan: {
              include: {
                consultantProfile: {
                  select: { id: true, userId: true },
                },
              },
            },
          },
        },
        class: {
          include: {
            classPlan: {
              include: {
                consultantProfile: {
                  select: { id: true, userId: true },
                },
              },
            },
          },
        },
      },
    });

    if (!appointment) {
      return NextResponse.json(
        {
          error: "Access denied",
          message:
            "Appointment not found or you don't have consultant access to it",
          code: "FORBIDDEN",
        },
        { status: 403 },
      );
    }

    // Get consultant ID
    const consultantId =
      appointment.consultation?.consultationPlan?.consultantProfile?.id ||
      appointment.subscription?.subscriptionPlan?.consultantProfile?.id ||
      appointment.webinar?.webinarPlan?.consultantProfile?.id ||
      appointment.class?.classPlan?.consultantProfile?.id;

    if (!consultantId) {
      return NextResponse.json(
        {
          error: "Configuration error",
          message: "Could not determine consultant for this appointment",
          code: "SERVER_ERROR",
        },
        { status: 500 },
      );
    }

    // Parse form data
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const description = formData.get("description") as string | null;
    const responseToDocumentId = formData.get("responseToDocumentId") as
      | string
      | null;

    if (!file) {
      return NextResponse.json(
        {
          error: "No file provided",
          message: "Please select a file to upload",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
    }

    // If responding to a specific document, verify it exists
    if (responseToDocumentId) {
      const originalDocument = await prisma.appointmentDocument.findFirst({
        where: {
          id: responseToDocumentId,
          appointmentId,
        },
      });

      if (!originalDocument) {
        return NextResponse.json(
          {
            error: "Original document not found",
            message: "The document you're responding to does not exist",
            code: "NOT_FOUND",
          },
          { status: 404 },
        );
      }
    }

    // Upload to Supabase
    const uploadResult = await uploadConsultantDocument({
      appointmentId,
      consultantId,
      file,
      responseToDocumentId: responseToDocumentId || undefined,
      description: description || undefined,
    });

    if (!uploadResult.success) {
      return NextResponse.json(
        {
          error: "Upload failed",
          message: uploadResult.error || "Failed to upload file",
          code: "UPLOAD_ERROR",
        },
        { status: 500 },
      );
    }

    // Create database record
    const document = await prisma.appointmentDocument.create({
      data: {
        fileName: uploadResult.fileName!,
        originalName: file.name,
        fileSize: uploadResult.fileSize!,
        mimeType: uploadResult.mimeType!,
        fileUrl: uploadResult.fileUrl!,
        storagePath: uploadResult.storagePath!,
        description: description || null,
        uploadedByRole: "CONSULTANT",
        responseToDocumentId: responseToDocumentId || null,
        appointmentId,
        // Consultant uploads don't need review
        reviewStatus: "APPROVED",
        reviewedById: userId, // A8 — FK scalar (#676)
        reviewedAt: new Date(),
      },
    });

    return NextResponse.json({ data: document }, { status: 201 });
  } catch (error) {
    console.error("Error uploading consultant document:", error);
    return NextResponse.json(
      {
        error: "Server error",
        message: "Failed to upload document",
        code: "SERVER_ERROR",
      },
      { status: 500 },
    );
  }
}
