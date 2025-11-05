import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import {
  uploadAppointmentDocument,
  getManualBucketInstructions,
} from "@/lib/supabase";

// GET - List documents for an appointment
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to view documents",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    const { appointmentId } = await params;

    if (!appointmentId) {
      return NextResponse.json(
        {
          error: "Invalid appointment",
          message: "Appointment ID is required",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
    }

    // In development mode, allow access to any appointment's documents for testing
    const isDevelopment = process.env.NODE_ENV === "development";

    // Build access control conditions - bypass in development
    const whereClause: any = {
      id: appointmentId,
    };

    if (!isDevelopment) {
      whereClause.OR = [
        // User is the consultee
        {
          consultation: {
            requestedBy: {
              user: {
                id: session.user.id,
              },
            },
          },
        },
        // User is the consultant
        {
          consultation: {
            consultationPlan: {
              consultantProfile: {
                user: {
                  id: session.user.id,
                },
              },
            },
          },
        },
        // User is part of subscription
        {
          subscription: {
            OR: [
              {
                requestedBy: {
                  user: {
                    id: session.user.id,
                  },
                },
              },
              {
                subscriptionPlan: {
                  consultantProfile: {
                    user: {
                      id: session.user.id,
                    },
                  },
                },
              },
            ],
          },
        },
      ];
    }

    // Verify user has access to this appointment
    const appointment = await prisma.appointment.findFirst({
      where: whereClause,
      include: {
        consultation: {
          include: {
            consultationPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: { name: true },
                    },
                  },
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
                  include: {
                    user: {
                      select: { name: true },
                    },
                  },
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
          error: "Appointment not found",
          message: isDevelopment
            ? `[DEV MODE] This appointment ID (${appointmentId}) doesn't exist in the database. Please check the appointment details.`
            : "This appointment doesn't exist or you don't have permission to view it. Please check the appointment details or contact support if you believe this is an error.",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }

    // Get appointment details for better error context
    const appointmentTitle =
      appointment.consultation?.consultationPlan?.title ||
      appointment.subscription?.subscriptionPlan?.title ||
      "Unknown Appointment";
    const consultantName =
      appointment.consultation?.consultationPlan?.consultantProfile?.user
        ?.name ||
      appointment.subscription?.subscriptionPlan?.consultantProfile?.user
        ?.name ||
      "Unknown Consultant";

    // Fetch documents - this should never fail, even if folder doesn't exist
    let documents;
    try {
      documents = await prisma.appointmentDocument.findMany({
        where: {
          appointmentId,
        },
        orderBy: {
          uploadedAt: "desc",
        },
      });
    } catch (dbError) {
      console.error("Database error fetching documents:", dbError);
      // Return empty array instead of failing - documents folder might not exist yet
      return NextResponse.json({
        data: [],
        message:
          "No documents found for this appointment yet. Upload your first document to get started!",
        appointmentTitle: isDevelopment
          ? `${appointmentTitle} [DEV MODE]`
          : appointmentTitle,
        consultantName,
      });
    }

    const devModeMessage = isDevelopment
      ? " [DEV MODE - Access control bypassed]"
      : "";

    return NextResponse.json({
      data: documents,
      count: documents.length,
      message:
        documents.length === 0
          ? `No documents uploaded yet. You can upload documents like resumes, tax returns, or other files for review.${devModeMessage}`
          : `Found ${documents.length} document${documents.length === 1 ? "" : "s"} for this appointment.${devModeMessage}`,
      appointmentTitle: isDevelopment
        ? `${appointmentTitle} [DEV MODE]`
        : appointmentTitle,
      consultantName,
    });
  } catch (error) {
    console.error("Error fetching appointment documents:", error);

    // Provide specific error messages based on error type
    if (error instanceof Error) {
      if (
        error.message.includes("connect") ||
        error.message.includes("timeout")
      ) {
        return NextResponse.json(
          {
            error: "Connection error",
            message:
              "Unable to connect to the server. Please check your internet connection and try again.",
            code: "CONNECTION_ERROR",
          },
          { status: 503 },
        );
      }

      if (
        error.message.includes("Prisma") ||
        error.message.includes("database")
      ) {
        return NextResponse.json(
          {
            error: "Database temporarily unavailable",
            message:
              "The document system is temporarily unavailable. Please try again in a few moments.",
            code: "DATABASE_ERROR",
          },
          { status: 503 },
        );
      }
    }

    return NextResponse.json(
      {
        error: "Unable to load documents",
        message:
          "Something went wrong while loading your documents. Please refresh the page or try again later. If the problem persists, contact support.",
        code: "UNKNOWN_ERROR",
      },
      { status: 500 },
    );
  }
}

// POST - Upload a new document
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const session = await getServerSession(authOptions);
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

    if (!appointmentId) {
      return NextResponse.json(
        {
          error: "Invalid appointment",
          message: "Appointment ID is required",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
    }

    let formData;
    try {
      formData = await request.formData();
    } catch (parseError) {
      return NextResponse.json(
        {
          error: "Invalid file upload",
          message:
            "The uploaded file appears to be corrupted or invalid. Please try uploading the file again.",
          code: "INVALID_FILE",
        },
        { status: 400 },
      );
    }

    const file = formData.get("file") as File;
    const description = formData.get("description") as string;

    if (!file || file.size === 0) {
      return NextResponse.json(
        {
          error: "No file selected",
          message:
            "Please select a file to upload. Supported formats include PDF, Word documents, images, and text files.",
          code: "NO_FILE",
        },
        { status: 400 },
      );
    }

    // Enhanced file validation
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      return NextResponse.json(
        {
          error: "File too large",
          message: `The selected file is ${Math.round(file.size / 1024 / 1024)}MB. Please select a file smaller than 10MB.`,
          code: "FILE_TOO_LARGE",
        },
        { status: 400 },
      );
    }

    const allowedTypes = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/gif",
      "text/plain",
    ];

    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json(
        {
          error: "Unsupported file type",
          message: `The file type "${file.type}" is not supported. Please upload a PDF, Word document, image (JPG, PNG, GIF), or text file.`,
          code: "UNSUPPORTED_FILE_TYPE",
        },
        { status: 400 },
      );
    }

    // In development mode, allow uploads to any appointment for testing
    const isDevelopment = process.env.NODE_ENV === "development";

    // Build access control conditions - bypass in development
    const uploadWhereClause: any = {
      id: appointmentId,
    };

    if (!isDevelopment) {
      uploadWhereClause.OR = [
        {
          consultation: {
            requestedBy: {
              user: {
                id: session.user.id,
              },
            },
          },
        },
        {
          subscription: {
            requestedBy: {
              user: {
                id: session.user.id,
              },
            },
          },
        },
      ];
    }

    // Verify user has access to this appointment and get consultee ID
    const appointment = await prisma.appointment.findFirst({
      where: uploadWhereClause,
      include: {
        consultation: {
          include: {
            requestedBy: {
              include: {
                user: true,
              },
            },
            consultationPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: { name: true },
                    },
                  },
                },
              },
            },
          },
        },
        subscription: {
          include: {
            requestedBy: {
              include: {
                user: true,
              },
            },
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: { name: true },
                    },
                  },
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
          error: "Appointment not found",
          message: isDevelopment
            ? `[DEV MODE] Appointment ${appointmentId} not found in database.`
            : "You can only upload documents to your own appointments. Please check the appointment details.",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }

    // Get consultee ID from appointment or use session user ID as fallback for dev mode
    const consulteeId =
      appointment.consultation?.requestedBy?.id ||
      appointment.subscription?.requestedBy?.id ||
      (isDevelopment ? session.user.id : null);

    if (!consulteeId) {
      return NextResponse.json(
        {
          error: "Invalid appointment setup",
          message:
            "There's an issue with this appointment setup. Please contact support for assistance.",
          code: "INVALID_APPOINTMENT",
        },
        { status: 400 },
      );
    }

    // Upload file to Supabase with enhanced error handling
    let uploadResult;
    try {
      uploadResult = await uploadAppointmentDocument({
        appointmentId,
        consulteeId,
        description,
        file,
      });
    } catch (uploadError) {
      console.error("File upload error:", uploadError);

      if (uploadError instanceof Error) {
        if (
          uploadError.message.includes("network") ||
          uploadError.message.includes("fetch")
        ) {
          return NextResponse.json(
            {
              error: "Network error",
              message:
                "Upload failed due to a network issue. Please check your connection and try again.",
              code: "NETWORK_ERROR",
            },
            { status: 503 },
          );
        }

        if (
          uploadError.message.includes("storage") ||
          uploadError.message.includes("bucket")
        ) {
          return NextResponse.json(
            {
              error: "Storage error",
              message:
                "There's a temporary issue with file storage. Please try again in a few moments.",
              code: "STORAGE_ERROR",
            },
            { status: 503 },
          );
        }
      }

      return NextResponse.json(
        {
          error: "Upload failed",
          message:
            "Failed to upload the file. Please try again or contact support if the issue persists.",
          code: "UPLOAD_ERROR",
        },
        { status: 500 },
      );
    }

    if (!uploadResult.success) {
      const isBucketError =
        uploadResult.error?.includes("bucket") ||
        uploadResult.error?.includes("storage");

      return NextResponse.json(
        {
          error: "Upload failed",
          message:
            uploadResult.error ||
            "The file upload was unsuccessful. Please try again.",
          code: isBucketError ? "BUCKET_NOT_FOUND" : "UPLOAD_FAILED",
          ...(isBucketError && {
            instructions: getManualBucketInstructions("documents"),
            technical: uploadResult.error,
          }),
        },
        { status: 400 },
      );
    }

    // Save document record to database
    let document;
    try {
      document = await prisma.appointmentDocument.create({
        data: {
          appointmentId,
          fileName: uploadResult.fileName!,
          originalName: file.name,
          fileSize: uploadResult.fileSize!,
          mimeType: uploadResult.mimeType!,
          fileUrl: uploadResult.fileUrl!,
          storagePath: uploadResult.storagePath!,
          description: description?.trim() || null,
          reviewStatus: "PENDING",
        },
      });
    } catch (dbError) {
      console.error("Database error saving document:", dbError);

      // Try to clean up uploaded file if database save failed
      try {
        const { deleteAppointmentDocument } = await import("@/lib/supabase");
        await deleteAppointmentDocument(uploadResult.storagePath!);
      } catch (cleanupError) {
        console.error("Failed to cleanup uploaded file:", cleanupError);
      }

      return NextResponse.json(
        {
          error: "Save failed",
          message:
            "The file was uploaded but couldn't be saved to your account. Please try again or contact support.",
          code: "SAVE_FAILED",
        },
        { status: 500 },
      );
    }

    const appointmentTitle =
      appointment.consultation?.consultationPlan?.title ||
      appointment.subscription?.subscriptionPlan?.title ||
      "your appointment";
    const consultantName =
      appointment.consultation?.consultationPlan?.consultantProfile?.user
        ?.name ||
      appointment.subscription?.subscriptionPlan?.consultantProfile?.user
        ?.name ||
      "your consultant";

    const devModeMessage = isDevelopment
      ? " [DEV MODE - Access control bypassed]"
      : "";

    return NextResponse.json(
      {
        data: document,
        message: `Successfully uploaded "${file.name}" for ${appointmentTitle}. ${consultantName} will review it and provide feedback.${devModeMessage}`,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("Error uploading document:", error);

    // Provide specific error messages based on error type
    if (error instanceof Error) {
      if (
        error.message.includes("connect") ||
        error.message.includes("timeout")
      ) {
        return NextResponse.json(
          {
            error: "Connection error",
            message:
              "Upload failed due to connection issues. Please check your internet connection and try again.",
            code: "CONNECTION_ERROR",
          },
          { status: 503 },
        );
      }
    }

    return NextResponse.json(
      {
        error: "Upload error",
        message:
          "Something went wrong during the upload. Please try again or contact support if the problem continues.",
        code: "UNKNOWN_ERROR",
      },
      { status: 500 },
    );
  }
}
