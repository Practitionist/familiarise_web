import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { createSupportAttachmentSignedUrl } from "@/lib/supabase";
import { reportSentryError } from "@/lib/observability/report";

interface RouteParams {
  params: Promise<{ ticketId: string; attachmentId: string }>;
}

/**
 * GET /api/support-tickets/[ticketId]/attachments/[attachmentId]
 * Verify ticket ownership or operator permission and redirect to a short-lived signed storage URL.
 */
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

    const isOwner = attachment.ticket.userId === session.user.id;
    const isStaffOrAdmin = Boolean(
      user?.role && hasBackofficePermission(user.role, "tickets.manage"),
    );

    if (!isOwner && !isStaffOrAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const signedUrl = await createSupportAttachmentSignedUrl(
      attachment.storagePath,
      60,
    );
    if (!signedUrl) {
      reportSentryError(
        new Error("Failed to sign support attachment download URL"),
        {
          subsystem: "support",
          op: "sign_support_attachment",
          extra: { ticketId, attachmentId },
        },
      );
      return NextResponse.json(
        { error: "Failed to generate attachment download URL" },
        { status: 502 },
      );
    }

    const response = NextResponse.redirect(signedUrl, 302);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    reportSentryError(error, {
      subsystem: "support",
      op: "get_support_attachment_redirect",
    });
    return NextResponse.json(
      { error: "Failed to access attachment" },
      { status: 500 },
    );
  }
}
