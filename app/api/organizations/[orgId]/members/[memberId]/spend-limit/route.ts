import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const SpendLimitBodySchema = z.object({
  spendLimitPaise: z.number().int().min(100).nullable(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string; memberId: string }> },
) {
  const { orgId, memberId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: ["billing.manage", "programs.manage"],
    requireActive: true,
  });
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = SpendLimitBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid spend limit payload", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { spendLimitPaise } = parsed.data;

  const member = await prisma.membership.findFirst({
    where: {
      organizationId: orgId,
      OR: [{ id: memberId }, { userId: memberId }],
    },
    select: { id: true, userId: true },
  });
  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  const actorMembershipId =
    access.member.id === "ADMIN" ? null : access.member.id;

  await prisma.orgAuditLog.create({
    data: {
      organizationId: orgId,
      actorMembershipId,
      targetMembershipId: member.id,
      category: "PROGRAM",
      action: AUDIT_ACTIONS.PROGRAM.PROGRAM_ASSIGNMENT_UPDATED,
      description:
        spendLimitPaise === null
          ? "Cleared member spend limit"
          : `Updated member spend limit to ₹${(spendLimitPaise / 100).toFixed(2)}`,
      details: {
        memberId: member.id,
        userId: member.userId,
        spendLimitPaise,
      },
    },
  });

  return NextResponse.json({
    membershipId: member.id,
    userId: member.userId,
    spendLimitPaise,
  });
}
