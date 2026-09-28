/**
 * POST /api/organizations/[orgId]/consent/withdrawal-requests
 *
 * #1527 decision 5 — only the member grants or withdraws their DPDP consent.
 * When a member asks the organisation to stop, an operator
 * (consent.requestWithdrawal: OWNER, MAINTAINER, MANAGER) records the request
 * here. Nothing is withdrawn: the audit row is the request, and the member's
 * Account › Data consent section lists it next to their Withdraw control until
 * they withdraw or give that consent again (GET ../consent).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { checkConsent } from "@/lib/compliance/dpdp";
import { normalizePurposeCode } from "@/lib/compliance/purpose-codes";

const BodySchema = z.object({
  userId: z.string().min(1).max(128),
  purposeCode: z.string().min(1).max(64),
  reason: z.string().trim().max(500).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "consent.requestWithdrawal",
  });
  if (access.error) return access.error;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { userId } = parsed.data;
  const reason = parsed.data.reason || null;
  const purposeCode = normalizePurposeCode(parsed.data.purposeCode);
  if (purposeCode === undefined) {
    return NextResponse.json(
      {
        error: "Unknown purpose code",
        detail: { purposeCode: parsed.data.purposeCode },
      },
      { status: 400 },
    );
  }
  if (userId === access.session.user.id) {
    return NextResponse.json(
      { error: "Withdraw your own consent in Account settings › Data consent" },
      { status: 400 },
    );
  }

  const member = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId: orgId } },
    select: { id: true },
  });
  if (!member) {
    return NextResponse.json(
      { error: "User is not a member of this organization" },
      { status: 404 },
    );
  }
  if (!(await checkConsent({ userId, purposeCode }))) {
    return NextResponse.json(
      {
        error: "This member has no active consent for that purpose",
        code: "CONSENT_NOT_ACTIVE",
      },
      { status: 409 },
    );
  }

  // Not best-effort: the row IS the request, so a failed write fails the call.
  const request = await prisma.orgAuditLog.create({
    data: {
      organizationId: orgId,
      actorMembershipId: access.member.id,
      targetMembershipId: member.id,
      category: "CONSENT",
      action: AUDIT_ACTIONS.CONSENT.CONSENT_WITHDRAWAL_REQUESTED,
      // PII hygiene as CONSENT_GRANTED: the membership FK is the pivot and
      // the free-text reason stays in `details`.
      description: `Consent withdrawal requested (purpose=${purposeCode}) for member ${member.id}`,
      details: {
        membershipId: member.id,
        purposeCode,
        reason,
        requestedByMembershipId: access.member.id,
      },
    },
    select: { id: true, createdAt: true },
  });

  return NextResponse.json(
    { request: { ...request, purposeCode, reason } },
    { status: 201 },
  );
}
