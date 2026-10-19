import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import {
  attachmentDownload,
  attachmentCaseAccess,
} from "@/lib/support/case-attachments";
interface Context {
  params: Promise<{ attachmentId: string }>;
}
export async function GET(_req: NextRequest, context: Context) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const { attachmentId } = await context.params;
  const href = await attachmentDownload(attachmentId, {
    userId: auth.session.user.id,
    role: auth.session.user.role,
  });
  return href
    ? NextResponse.redirect(href, {
        headers: { "Cache-Control": "private, no-store" },
      })
    : NextResponse.json({ error: "Not found" }, { status: 404 });
}
export async function DELETE(_req: NextRequest, context: Context) {
  const auth = await requireApiAuth({ expectUser: true });
  if (auth.error) return auth.error;
  const { attachmentId } = await context.params;
  const row = await prisma.supportCaseAttachment.findFirst({
    where: {
      id: attachmentId,
      uploadedById: auth.session.user.id,
      deletedAt: null,
    },
    include: {
      supportCase: {
        select: { decisions: { take: 1, select: { id: true } }, status: true },
      },
    },
  });
  if (
    !row ||
    !(await attachmentCaseAccess(
      row.caseId,
      { userId: auth.session.user.id, role: auth.session.user.role },
      row.evidenceRequestId ?? undefined,
    ))
  )
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (
    row.completedAt ||
    row.supportCase.decisions.length ||
    row.supportCase.status === "CLOSED"
  )
    return NextResponse.json(
      {
        error:
          "Submitted evidence is retained with the case. Contact support to request removal.",
      },
      { status: 409 },
    );
  await prisma.supportCaseAttachment.updateMany({
    where: { id: attachmentId, completedAt: null, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  return NextResponse.json({ success: true });
}
