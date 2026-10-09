/**
 * GET /api/support-tickets/[ticketId]/attachments/[attachmentId]
 * Redirects the ticket owner or staff/admin to a short-lived signed URL for the file.
 */

import { NextRequest, NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { signSupportTicketAttachment } from "@/lib/supabase";

interface RouteParams {
  params: Promise<{ ticketId: string; attachmentId: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { ticketId, attachmentId } = await params;
    const [user, attachment] = await Promise.all([
      prisma.user.findUnique({
        where: { id: session.user.id },
        select: { role: true },
      }),
      prisma.supportTicketAttachment.findUnique({
        where: { id: attachmentId },
        select: {
          ticketId: true,
          storagePath: true,
          ticket: { select: { userId: true } },
        },
      }),
    ]);

    if (!attachment || attachment.ticketId !== ticketId) {
      return NextResponse.json(
        { error: "Attachment not found" },
        { status: 404 },
      );
    }

    const isStaffOrAdmin =
      user?.role === UserRole.STAFF || user?.role === UserRole.ADMIN;
    if (attachment.ticket.userId !== session.user.id && !isStaffOrAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const signedUrl = await signSupportTicketAttachment(attachment.storagePath);
    if (!signedUrl) {
      return NextResponse.json(
        { error: "Attachment file is unavailable" },
        { status: 404 },
      );
    }

    const response = NextResponse.redirect(signedUrl, 302);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "support" } },
    );
    return NextResponse.json(
      { error: "Failed to open attachment" },
      { status: 500 },
    );
  }
}
