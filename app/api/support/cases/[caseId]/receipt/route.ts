import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth-helpers";
import prisma from "@/lib/prisma";
import { canCorrespondOnCase } from "@/lib/support/case-access";
import { sessionRole } from "@/lib/auth/session-role";
import { parseRouteParams } from "@/lib/api/support-http";
import { CaseIdParams } from "@/schemas/support";
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ caseId: string }> },
) {
  const id = await parseRouteParams(CaseIdParams, context.params, {
    route: "support.case.receipt",
  });
  if (!id.ok) return id.response;
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const { caseId } = id.data;
  const row = await prisma.supportCase.findFirst({
    where: { id: caseId, deletedAt: null },
    select: {
      id: true,
      referenceNumber: true,
      title: true,
      description: true,
      createdAt: true,
      requesterUserId: true,
      submitterUserId: true,
      organizationId: true,
      ownershipScope: true,
      externalRequesterEmail: true,
      messages: {
        where: { sender: "USER", isInternal: false },
        orderBy: { seq: "asc" },
        take: 1,
        select: { body: true, createdAt: true },
      },
    },
  });
  if (
    !row ||
    !(await canCorrespondOnCase(row, {
      userId: auth.session.user.id,
      role: sessionRole(auth.session.user.role),
    }))
  )
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(
    {
      reference: row.referenceNumber,
      submittedAt: row.messages[0]?.createdAt ?? row.createdAt,
      subject: row.title,
      complaint: row.messages[0]?.body ?? row.description,
    },
    {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${row.referenceNumber.replace(/[^A-Za-z0-9-]/g, "_")}.json"`,
      },
    },
  );
}
