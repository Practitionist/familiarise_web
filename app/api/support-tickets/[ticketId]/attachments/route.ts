/**
 * Support Ticket Attachments API
 * Upload and list attachments for support tickets
 * Accessible by ticket owner or staff/admin
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  uploadSupportTicketAttachment,
  deleteSupportTicketAttachment,
  getManualBucketInstructions,
} from "@/lib/supabase";
import { UserRole } from "@prisma/client";

import { getSession } from "@/lib/auth-server";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import * as Sentry from "@sentry/nextjs";
interface RouteParams {
  params: Promise<{ ticketId: string }>;
}

/**
 * GET /api/support-tickets/[ticketId]/attachments
 * List all attachments for a support ticket
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { ticketId } = await params;

    // Get user role
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    const isStaffOrAdmin =
      user?.role === UserRole.STAFF || user?.role === UserRole.ADMIN;

    // Verify ticket exists and user has access
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { userId: true },
    });

    if (!ticket) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

    // Only ticket owner or staff/admin can view attachments
    if (ticket.userId !== session.user.id && !isStaffOrAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const attachments = await prisma.supportTicketAttachment.findMany({
      where: { ticketId },
      orderBy: { uploadedAt: "desc" },
    });

    return NextResponse.json({ attachments });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "support" } },
    );
    console.error("Error fetching attachments:", error);
    return NextResponse.json(
      { error: "Failed to fetch attachments" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/support-tickets/[ticketId]/attachments
 * Upload a new attachment to a support ticket
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rl = await applyRateLimit(
      spamLimiter,
      `ticket-attachment:${session.user.id}`,
    );
    if (rl) return rl;

    const { ticketId } = await params;

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    const isStaffOrAdmin =
      user?.role === UserRole.STAFF || user?.role === UserRole.ADMIN;

    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { userId: true, status: true },
    });

    if (!ticket) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

    if (ticket.userId !== session.user.id && !isStaffOrAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (ticket.status === "CLOSED") {
      return NextResponse.json(
        { error: "Cannot upload attachments to a closed ticket" },
        { status: 400 },
      );
    }

    const existingCount = await prisma.supportTicketAttachment.count({
      where: { ticketId },
    });

    if (existingCount >= 5) {
      return NextResponse.json(
        { error: "Maximum 5 attachments allowed per ticket" },
        { status: 400 },
      );
    }

    let formData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json(
        { error: "Invalid file upload" },
        { status: 400 },
      );
    }

    const file = formData.get("file") as File;

    if (!file || file.size === 0) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const uploadResult = await uploadSupportTicketAttachment({
      ticketId,
      file,
    });

    if (!uploadResult.success) {
      const isBucketError =
        uploadResult.error?.includes("bucket") ||
        uploadResult.error?.includes("storage");

      return NextResponse.json(
        {
          error: "Upload failed",
          message: uploadResult.error,
          ...(isBucketError && {
            instructions: getManualBucketInstructions("support-attachments"),
          }),
        },
        { status: 400 },
      );
    }

    let attachment;
    try {
      attachment = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "SupportTicket" WHERE id = ${ticketId} FOR UPDATE`;
        const currentCount = await tx.supportTicketAttachment.count({
          where: { ticketId },
        });
        if (currentCount >= 5) {
          return null;
        }
        return tx.supportTicketAttachment.create({
          data: {
            ticketId,
            fileName: uploadResult.fileName!,
            originalName: file.name,
            fileSize: uploadResult.fileSize!,
            mimeType: uploadResult.mimeType!,
            fileUrl: uploadResult.fileUrl!,
            storagePath: uploadResult.storagePath!,
          },
        });
      });
    } catch (txErr) {
      await deleteSupportTicketAttachment(uploadResult.storagePath!).catch(
        () => {},
      );
      throw txErr;
    }

    if (!attachment) {
      await deleteSupportTicketAttachment(uploadResult.storagePath!);
      return NextResponse.json(
        { error: "Maximum 5 attachments allowed per ticket" },
        { status: 400 },
      );
    }

    return NextResponse.json(
      { attachment, message: "Attachment uploaded successfully" },
      { status: 201 },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "support" } },
    );
    console.error("Error uploading attachment:", error);
    return NextResponse.json(
      { error: "Failed to upload attachment" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/support-tickets/[ticketId]/attachments
 * Delete an attachment (requires attachmentId in body)
 */
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rl = await applyRateLimit(
      spamLimiter,
      `ticket-attachment-del:${session.user.id}`,
    );
    if (rl) return rl;

    const { ticketId } = await params;
    const body = await req.json();
    const { attachmentId } = body;

    if (!attachmentId) {
      return NextResponse.json(
        { error: "Attachment ID required" },
        { status: 400 },
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    const isStaffOrAdmin =
      user?.role === UserRole.STAFF || user?.role === UserRole.ADMIN;

    const attachment = await prisma.supportTicketAttachment.findUnique({
      where: { id: attachmentId },
      include: {
        ticket: { select: { userId: true, status: true } },
      },
    });

    if (!attachment || attachment.ticketId !== ticketId) {
      return NextResponse.json(
        { error: "Attachment not found" },
        { status: 404 },
      );
    }

    if (attachment.ticket.userId !== session.user.id && !isStaffOrAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (attachment.ticket.status === "CLOSED") {
      return NextResponse.json(
        { error: "Cannot delete attachments from a closed ticket" },
        { status: 400 },
      );
    }

    await deleteSupportTicketAttachment(attachment.storagePath);

    await prisma.supportTicketAttachment.delete({
      where: { id: attachmentId },
    });

    return NextResponse.json({ message: "Attachment deleted successfully" });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "support" } },
    );
    console.error("Error deleting attachment:", error);
    return NextResponse.json(
      { error: "Failed to delete attachment" },
      { status: 500 },
    );
  }
}
