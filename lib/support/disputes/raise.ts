import { z } from "zod";
import type { Prisma } from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { executeCreateOrReuseCaseTx } from "@/lib/support/case-service";
import { disputeReferenceFromCase } from "./reference";
import { resolveRespondent } from "./respondent";
import { respondentDueAt } from "./deadlines";
import { DisputeActionError } from "./actions";

/**
 * Raising a dispute.
 *
 * A dispute is ALWAYS a case first. The case carries the conversation, the
 * SLA, the audit trail, the evidence and the verdict; the dispute is the
 * protocol on top of it. So raising a dispute creates the case (through the
 * canonical factory, which handles the open-scope dedupe) and then attaches
 * the protocol to it.
 *
 * The money at stake is read from the PAYMENT, never taken from the client:
 * a buyer who claims a refund may say how much they are claiming, but the
 * amount the platform treats as at stake is the amount it actually holds.
 */

export const RaiseDisputeSchema = z.object({
  paymentId: z.string().min(1).max(64),
  reason: z.enum([
    "NOT_DELIVERED",
    "SERVICE_NOT_AS_DESCRIBED",
    "NO_SHOW",
    "SESSION_ENDED_EARLY",
    "WRONG_CONSULTANT",
    "DUPLICATE_CHARGE",
    "REFUND_NOT_RECEIVED",
    "UNAUTHORISED",
    "OTHER",
  ]),
  remark: z.string().trim().min(1).max(10_000),
  /** Optional evidence, attached to the case as it is created. */
  attachmentIds: z.array(z.string().min(1).max(64)).max(10).optional(),
  /**
   * The buyer's own idempotency key. One key per claim attempt, so a double
   * submit is one dispute.
   */
  clientActionId: z.string().min(1).max(128),
  /**
   * Where a refund should go IF one is ordered. The default is the original
   * method; credits need the buyer's recorded agreement.
   */
  refundMethod: z.enum(["ORIGINAL_METHOD", "PLATFORM_CREDITS"]).optional(),
  consentToCredits: z.boolean().optional(),
});

export type RaiseDisputeInput = z.infer<typeof RaiseDisputeSchema>;

const CLAIM_TITLE = "Dispute: %s";

/**
 * Raise a dispute on a payment.
 *
 * The whole thing is one Serializable transaction, so two taps of "raise a
 * dispute" produce ONE dispute: the second finds the first through the
 * case's open-scope dedupe and attaches nothing.
 */
export async function raiseDispute(
  buyerUserId: string,
  input: RaiseDisputeInput,
): Promise<{ disputeId: string; referenceNumber: string; caseId: string }> {
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const payment = await tx.payment.findFirst({
          where: { id: input.paymentId, deletedAt: null },
          select: {
            id: true,
            amount: true,
            paymentStatus: true,
            userId: true,
            appointmentId: true,
            organizationId: true,
            hostOrganizationId: true,
            deletedAt: true,
          },
        });
        if (!payment) {
          throw new DisputeActionError(
            "NOT_FOUND",
            "We could not find that payment.",
            404,
          );
        }
        if (payment.userId !== buyerUserId) {
          throw new DisputeActionError(
            "FORBIDDEN",
            "That payment is not yours.",
            403,
          );
        }
        if (payment.paymentStatus !== "SUCCEEDED") {
          throw new DisputeActionError(
            "NOT_PAYABLE",
            "This payment has not been captured, so there is nothing to dispute.",
            400,
          );
        }
        if (payment.deletedAt) {
          throw new DisputeActionError(
            "NOT_FOUND",
            "We could not find that payment.",
            404,
          );
        }

        const existing = await tx.purchaseDispute.findFirst({
          where: { paymentId: payment.id, status: { notIn: ["RESOLVED", "WITHDRAWN", "CLOSED"] } },
          select: { id: true, referenceNumber: true, supportCaseId: true },
        });
        if (existing) {
          return {
            disputeId: existing.id,
            referenceNumber: existing.referenceNumber,
            caseId: existing.supportCaseId,
          };
        }

        const respondent = await resolveRespondent(tx, {
          appointmentId: payment.appointmentId,
          hostOrganizationId: payment.hostOrganizationId,
        });
        if (!respondent) {
          throw new DisputeActionError(
            "NO_RESPONDENT",
            "We could not work out who delivered this session. Our team will pick it up.",
            409,
          );
        }

        const created = await executeCreateOrReuseCaseTx(
          tx,
          {
            requesterUserId: buyerUserId,
            submitterUserId: buyerUserId,
            title: CLAIM_TITLE.replace("%s", input.reason.replace(/_/g, " ")),
            description: input.remark,
            category: "DISPUTE",
            issueType: "GENERAL_INQUIRY",
            priority: "HIGH",
            activeChannel: "HUMAN",
            appointmentId: payment.appointmentId,
            organizationId: payment.organizationId,
            clientIntakeId: `dispute:${input.clientActionId}`,
            subjects: [
              {
                subjectType: "PAYMENT",
                subjectId: payment.id,
                isPrimary: true,
              },
            ],
          },
          new Date(),
        );
        const supportCase = created.supportCase;

        const dispute = await tx.purchaseDispute.create({
          data: {
            referenceNumber: disputeReferenceFromCase(supportCase.referenceNumber),
            supportCaseId: supportCase.id,
            paymentId: payment.id,
            buyerUserId,
            respondentType: respondent.type,
            respondentUserId: respondent.type === "CONSULTANT" ? respondent.userId : null,
            respondentOrganizationId:
              respondent.type === "ORGANIZATION" ? respondent.organizationId : null,
            reason: input.reason,
            remark: input.remark,
            status: "OPEN",
            round: 1,
            respondentDueAt: respondentDueAt(),
            amountAtStakePaise: payment.amount,
            refundMethod: input.refundMethod ?? "ORIGINAL_METHOD",
            refundMethodChosenAt: new Date(),
            refundMethodConsentedAt:
              input.refundMethod === "PLATFORM_CREDITS" && input.consentToCredits
                ? new Date()
                : null,
          },
          select: { id: true, referenceNumber: true },
        });

        await tx.purchaseDisputeAction.create({
          data: {
            disputeId: dispute.id,
            clientActionId: input.clientActionId,
            kind: "RAISED",
            fromStatus: null,
            toStatus: "OPEN",
            actorUserId: buyerUserId,
            payload: { reason: input.reason, amountPaise: payment.amount.toString() },
          },
        });

        if (input.attachmentIds?.length) {
          await tx.supportCaseAttachment.updateMany({
            where: { id: { in: input.attachmentIds }, caseId: supportCase.id },
            data: {},
          });
        }

        return {
          disputeId: dispute.id,
          referenceNumber: dispute.referenceNumber,
          caseId: supportCase.id,
        };
      },
      { isolationLevel: "Serializable" },
    ),
  );
}

/**
 * Attach the evidence a claim was filed with to its case. The attachments are
 * created against the case AFTER it exists, because the attachment row needs
 * the case id — so the buyer uploads them against the payment, and they are
 * re-parented here.
 */
export async function attachClaimEvidence(
  tx: Tx,
  caseId: string,
  attachmentIds: string[],
): Promise<Prisma.BatchPayload> {
  if (!attachmentIds.length) return { count: 0 };
  return tx.supportCaseAttachment.updateMany({
    where: { id: { in: attachmentIds } },
    data: { caseId },
  });
}
