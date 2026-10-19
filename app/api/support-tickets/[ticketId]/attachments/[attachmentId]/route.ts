import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { attachmentDownload } from "@/lib/support/case-attachments";
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ ticketId: string; attachmentId: string }> },
) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const { ticketId, attachmentId } = await context.params;
  const alias = await prisma.supportCaseLegacyAlias.findUnique({
    where: {
      legacyKind_legacyId: { legacyKind: "ticket", legacyId: ticketId },
    },
    select: { caseId: true },
  });
  const legacy = alias
    ? await prisma.supportCaseAttachment.findFirst({
        where: { caseId: alias.caseId, legacyAttachmentId: attachmentId },
        select: { id: true },
      })
    : null;
  if (!legacy)
    return NextResponse.json(
      {
        error: "Open this evidence from the case timeline.",
        code: "ENDPOINT_RETIRED",
      },
      { status: 410 },
    );
  const href = await attachmentDownload(legacy.id, {
    userId: auth.session.user.id,
    role: auth.session.user.role,
  });
  return href
    ? NextResponse.redirect(href, {
        headers: { "Cache-Control": "private, no-store" },
      })
    : NextResponse.json({ error: "Not found" }, { status: 404 });
}
