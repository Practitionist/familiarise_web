import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
export async function GET() {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const data = await prisma.supportCaseEvidenceRequest.findMany({ where: { recipientUserId: auth.session.user.id }, orderBy: [{ respondedAt: "asc" }, { dueAt: "asc" }], take: 100, select: { id: true, caseId: true, prompt: true, dueAt: true, respondedAt: true, cancelledAt: true } });
  return NextResponse.json({ data });
}
