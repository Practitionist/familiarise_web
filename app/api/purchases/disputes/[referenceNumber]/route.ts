import { NextResponse, type NextRequest } from "next/server";

import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { supportError } from "@/lib/api/support-http";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { isDisputeReference } from "@/lib/support/disputes/reference";
import {
  DISPUTE_REASON_LABEL,
  DISPUTE_STATUS_LABEL,
  DISPUTE_STATUS_OWNER,
} from "@/lib/support/disputes/protocol";
import { organizationRespondentIds } from "@/lib/support/disputes/respondent";

interface RouteContext {
  params: Promise<{ referenceNumber: string }>;
}

/**
 * The dispute detail: the protocol, the parties, and the timeline.
 *
 * The viewer may be the buyer, the respondent, a member of the respondent
 * organisation, or a platform operator. Each sees the same protocol and a
 * different slice of the money: only the platform sees the internal
 * recommendation, and only the platform sees an internal note.
 */
export async function GET(_req: NextRequest, context: RouteContext) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const { referenceNumber } = await context.params;
  if (!isDisputeReference(referenceNumber)) {
    return supportError({ status: 400, code: "INVALID_ID" });
  }

  const userId = auth.session.user.id;
  const staff = hasBackofficePermission(auth.session.user.role, "tickets.manage");

  const dispute = await prisma.purchaseDispute.findUnique({
    where: { referenceNumber },
    select: {
      id: true,
      referenceNumber: true,
      status: true,
      reason: true,
      remark: true,
      round: true,
      version: true,
      buyerUserId: true,
      respondentType: true,
      respondentUserId: true,
      respondentOrganizationId: true,
      respondentResponse: true,
      respondentAcceptedRefund: true,
      respondentRespondedAt: true,
      respondentDueAt: true,
      buyerDecision: true,
      buyerDecisionAt: true,
      escalatedAt: true,
      escalatedReason: true,
      refundMethod: true,
      refundMethodConsentedAt: true,
      amountAtStakePaise: true,
      resolvedAt: true,
      createdAt: true,
      supportCaseId: true,
      payment: {
        select: {
          id: true,
          amount: true,
          currency: true,
          paymentStatus: true,
          organizationId: true,
          hostOrganizationId: true,
        },
      },
      supportCase: {
        select: {
          referenceNumber: true,
          status: true,
          title: true,
          assignedToId: true,
          messages: {
            where: { isInternal: false },
            orderBy: { seq: "asc" },
            take: 200,
            select: {
              id: true,
              seq: true,
              sender: true,
              body: true,
              createdAt: true,
              authorUserId: true,
            },
          },
        },
      },
      actions: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          kind: true,
          fromStatus: true,
          toStatus: true,
          actorUserId: true,
          createdAt: true,
        },
      },
    },
  });
  if (!dispute) {
    return supportError({ status: 404, code: "NOT_FOUND" });
  }

  // Who is this viewer in relation to the dispute?
  const isBuyer = dispute.buyerUserId === userId;
  const isRespondent = dispute.respondentUserId === userId;
  const orgMemberIds = dispute.respondentOrganizationId
    ? await organizationRespondentIds(prisma, dispute.respondentOrganizationId)
    : [];
  const isOrgRespondent = orgMemberIds.includes(userId);

  if (!staff && !isBuyer && !isRespondent && !isOrgRespondent) {
    return supportError({ status: 404, code: "NOT_FOUND" });
  }

  return NextResponse.json(
    {
      data: {
        id: dispute.id,
        referenceNumber: dispute.referenceNumber,
        status: dispute.status,
        statusLabel: DISPUTE_STATUS_LABEL[dispute.status],
        statusOwner: DISPUTE_STATUS_OWNER[dispute.status],
        reason: dispute.reason,
        reasonLabel:
          DISPUTE_REASON_LABEL[dispute.reason] ?? dispute.reason,
        remark: dispute.remark,
        round: dispute.round,
        version: dispute.version,
        viewerRole: staff
          ? "PLATFORM"
          : isBuyer
            ? "BUYER"
            : "RESPONDENT",
        amountPaise: dispute.amountAtStakePaise,
        refundMethod: dispute.refundMethod,
        respondent: {
          type: dispute.respondentType,
          userId: dispute.respondentUserId,
          organizationId: dispute.respondentOrganizationId,
        },
        respondentResponse: dispute.respondentResponse,
        respondentAcceptedRefund: dispute.respondentAcceptedRefund,
        respondentRespondedAt: dispute.respondentRespondedAt,
        respondentDueAt: dispute.respondentDueAt,
        buyerDecision: dispute.buyerDecision,
        buyerDecisionAt: dispute.buyerDecisionAt,
        escalatedAt: dispute.escalatedAt,
        escalatedReason: dispute.escalatedReason,
        resolvedAt: dispute.resolvedAt,
        createdAt: dispute.createdAt,
        payment: dispute.payment,
        case: {
          id: dispute.supportCaseId,
          referenceNumber: dispute.supportCase.referenceNumber,
          status: dispute.supportCase.status,
          title: dispute.supportCase.title,
          messages: dispute.supportCase.messages,
        },
        timeline: dispute.actions,
      },
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
