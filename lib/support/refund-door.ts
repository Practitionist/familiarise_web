import { z } from "zod";

import prisma from "@/lib/prisma";
import { assertMoneyOpsBudget } from "@/lib/backoffice/money-limit";
import { assertMoneyDoorsOpen } from "@/lib/backoffice/maintenance-gate";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { UserRoleEnum } from "@/schemas/user";
import {
  CaseRefundReviewSchema,
  hasRefundablePreview,
  REFUNDABLE_PREVIEW_REQUIRED,
} from "@/schemas/support-refund-review";
import { canCorrespondOnCase } from "./case-access";
import {
  assertIndependentReviewer,
  CaseActionError,
  performCaseAction,
  priceCaseRefundReview,
} from "./case-actions";

const Params = z.object({ caseId: z.string().min(1).max(64) });

export function rethrowCaseRefusal(error: unknown): never {
  if (error instanceof CaseActionError)
    throw new OpsRefusal(error.code, error.message, error.status);
  throw error;
}

const ReviewOutcome = z.object({
  paymentId: z.string(),
  amountPaise: z.coerce.number(),
  movedPaise: z.number().optional(),
  refund: z
    .object({
      refundId: z.string(),
      rail: z.string(),
      status: z.string().optional(),
    })
    .optional(),
});

/**
 * Case refunds share the admin money doors' approval, audit and budget. STAFF
 * execute within the bounded limits; above them the door asks for an ADMIN,
 * and above ₹25,000 per payment for a second one.
 */
export const reviewSupportRefundDoor = withOpsAction(
  "supportRefunds.executeBounded",
  "support.refund.review",
  CaseRefundReviewSchema.shape,
  {
    mode: "gateway",
    target: ({ body }) => ({
      kind: "SupportFinancialRecommendation",
      id: body.recommendationId,
    }),
    run: async ({ body, actor, params }) => {
      if (!hasRefundablePreview(body))
        throw new OpsRefusal("INVALID_BODY", REFUNDABLE_PREVIEW_REQUIRED, 400);
      await assertMoneyOpsBudget(actor.userId);
      if (body.approve) await assertMoneyDoorsOpen();
      const { caseId } = Params.parse(params);
      const data = await performCaseAction(
        caseId,
        { userId: actor.userId, role: UserRoleEnum.parse(actor.role) },
        body,
      ).catch(rethrowCaseRefusal);
      // The money already moved; an unexpected shape thins the audit row, never fails it.
      const parsed = ReviewOutcome.safeParse(data);
      const outcome = parsed.success ? parsed.data : null;
      return {
        target: {
          kind: "SupportFinancialRecommendation",
          id: body.recommendationId,
        },
        after: {
          caseId,
          approved: body.approve,
          paymentId: outcome?.paymentId ?? null,
          amountPaise: outcome?.amountPaise ?? null,
          movedPaise: outcome?.movedPaise ?? 0,
          refundId: outcome?.refund?.refundId ?? null,
          rail: outcome?.refund?.rail ?? null,
          refundStatus: outcome?.refund?.status ?? null,
        },
        response: { data },
      };
    },
  },
  {
    stepUp: true,
    secondApprover: {
      route: "/api/support/cases/[caseId]/actions",
      target: ({ body }) => ({
        kind: "SupportFinancialRecommendation",
        id: body.recommendationId,
      }),
      amountPaise: (body, { actor, params }) => {
        if (!hasRefundablePreview(body))
          throw new OpsRefusal(
            "INVALID_BODY",
            REFUNDABLE_PREVIEW_REQUIRED,
            400,
          );
        const { caseId } = Params.parse(params);
        return prisma
          .$transaction(async (tx) => {
            const supportCase = await tx.supportCase.findFirst({
              where: { id: caseId, deletedAt: null },
            });
            const reviewer = {
              userId: actor.userId,
              role: UserRoleEnum.parse(actor.role),
            };
            if (
              !supportCase ||
              !(await canCorrespondOnCase(supportCase, reviewer, tx))
            )
              throw new OpsRefusal("NOT_FOUND", "Support case not found.", 404);
            await assertIndependentReviewer(tx, supportCase, actor.userId);
            return priceCaseRefundReview(tx, caseId, reviewer, body);
          })
          .catch(rethrowCaseRefusal);
      },
    },
  },
);
