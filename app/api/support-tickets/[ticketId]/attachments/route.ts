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
} from "@/lib/supabase";
import { UserRole } from "@prisma/client";
import {
  supportAttachmentHref,
  withSupportAttachmentHrefs,
} from "@/lib/support/attachment-href";

import { getSession } from "@/lib/auth-server";
import { DeleteSupportAttachmentSchema } from "@/schemas/support";
import { documentUploadLimiter, applyRateLimit } from "@/lib/rate-limit";
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
    const session = await getSession();
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

    return NextResponse.json({
      attachments: withSupportAttachmentHrefs(attachments),
    });
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

/** Staff work across many cases, so only a customer's churn on one ticket is throttled. */
async function limitCustomerAttachmentChurn(
  verb: "upload" | "delete",
  userId: string,
  ticketId: string,
  isStaffOrAdmin: boolean,
): Promise<NextResponse | null> {
  if (isStaffOrAdmin) return null;
  return applyRateLimit(
    documentUploadLimiter,
    `ticket-attachment-${verb}:${userId}:${ticketId}`,
  );
}

async function verifyTicketAttachmentAccess(
  sessionUserId: string,
  ticketId: string,
): Promise<{ error: NextResponse } | { isStaffOrAdmin: boolean }> {
  const user = await prisma.user.findUnique({
    where: { id: sessionUserId },
    select: { role: true },
  });

  const isStaffOrAdmin =
    user?.role === UserRole.STAFF || user?.role === UserRole.ADMIN;

  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { userId: true, status: true },
  });

  if (!ticket) {
    return {
      error: NextResponse.json({ error: "Ticket not found" }, { status: 404 }),
    };
  }

  if (ticket.userId !== sessionUserId && !isStaffOrAdmin) {
    return {
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  if (ticket.status === "CLOSED") {
    return {
      error: NextResponse.json(
        { error: "Cannot upload attachments to a closed ticket" },
        { status: 400 },
      ),
    };
  }

  const existingCount = await prisma.supportTicketAttachment.count({
    where: { ticketId },
  });

  if (existingCount >= 5) {
    return {
      error: NextResponse.json(
        { error: "Maximum 5 attachments allowed per ticket" },
        { status: 400 },
      ),
    };
  }

  return { isStaffOrAdmin };
}

/**
 * POST /api/support-tickets/[ticketId]/attachments
 * Upload a new attachment to a support ticket
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { ticketId } = await params;

    const access = await verifyTicketAttachmentAccess(
      session.user.id,
      ticketId,
    );
    if ("error" in access) return access.error;

    const rl = await limitCustomerAttachmentChurn(
      "upload",
      session.user.id,
      ticketId,
      access.isStaffOrAdmin,
    );
    if (rl) return rl;

    let formData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json(
        { error: "Invalid file upload" },
        { status: 400 },
      );
    }

    const fileEntry = formData.get("file");
    if (!(fileEntry instanceof File) || fileEntry.size === 0) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    const file = fileEntry;

    const uploadResult = await uploadSupportTicketAttachment({
      ticketId,
      file,
    });

    const { fileName, fileSize, mimeType, storagePath } = uploadResult;
    if (
      !uploadResult.success ||
      !fileName ||
      !fileSize ||
      !mimeType ||
      !storagePath
    ) {
      Sentry.captureMessage("Support attachment upload failed", {
        level: "warning",
        tags: { subsystem: "support" },
        extra: { ticketId, reason: uploadResult.error },
      });
      return NextResponse.json(
        {
          error:
            "We couldn't upload that file. Use a PDF, Word document, image or text file under 10 MB and try again.",
        },
        { status: 400 },
      );
    }

    const attachmentId = globalThis.crypto.randomUUID();
    let attachment;
    try {
      // Row lock serialises concurrent uploads so the cap holds under races.
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
            id: attachmentId,
            ticketId,
            fileName,
            originalName: file.name,
            fileSize,
            mimeType,
            fileUrl: supportAttachmentHref(ticketId, attachmentId),
            storagePath,
          },
          omit: { storagePath: true },
        });
      });
    } catch (txErr) {
      await deleteSupportTicketAttachment(storagePath);
      throw txErr;
    }

    if (!attachment) {
      await deleteSupportTicketAttachment(storagePath);
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
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { ticketId } = await params;
    const body = DeleteSupportAttachmentSchema.safeParse(
      await req.json().catch(() => null),
    );
    if (!body.success) {
      return NextResponse.json(
        { error: "Attachment ID required" },
        { status: 400 },
      );
    }
    const { attachmentId } = body.data;

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

    const rl = await limitCustomerAttachmentChurn(
      "delete",
      session.user.id,
      ticketId,
      isStaffOrAdmin,
    );
    if (rl) return rl;

    // Storage first: on failure the row survives so the delete can be retried.
    if (!(await deleteSupportTicketAttachment(attachment.storagePath))) {
      Sentry.captureException(
        new Error("Support attachment storage delete failed"),
        { tags: { subsystem: "support" }, extra: { attachmentId } },
      );
      return NextResponse.json(
        { error: "Could not delete the file. Please try again." },
        { status: 502 },
      );
    }

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
