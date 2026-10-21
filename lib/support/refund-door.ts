import { z } from "zod";

import prisma from "@/lib/prisma";
import { assertMoneyOpsBudget } from "@/lib/backoffice/money-limit";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { UserRoleEnum } from "@/schemas/user";
import { CaseRefundReviewSchema } from "@/schemas/support-refund-review";
import { canCorrespondOnCase } from "./case-access";
import {
  assertIndependentReviewer,
  CaseActionError,
  performCaseAction,
} from "./case-actions";

const Params = z.object({ caseId: z.string().min(1).max(64) });

function rethrowCaseRefusal(error: unknown): never {
  if (error instanceof CaseActionError)
    throw new OpsRefusal(error.code, error.message, error.status);
  throw error;
}

/** Case refunds use the same approval, audit and execution budget as other admin refunds. */
export const reviewSupportRefundDoor = withOpsAction(
  "refunds.manage",
  "support.refund.review",
  CaseRefundReviewSchema.shape,
  {
    mode: "gateway",
    target: ({ body }) => ({
      kind: "SupportFinancialRecommendation",
      id: body.recommendationId,
    }),
    run: async ({ body, actor, params }) => {
      await assertMoneyOpsBudget(actor.userId);
      const { caseId } = Params.parse(params);
      const data = await performCaseAction(
        caseId,
        { userId: actor.userId, role: UserRoleEnum.parse(actor.role) },
        body,
      ).catch(rethrowCaseRefusal);
      return {
        target: {
          kind: "SupportFinancialRecommendation",
          id: body.recommendationId,
        },
        after: { caseId, approved: body.approve },
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
            const recommendation =
              await tx.supportFinancialRecommendation.findFirst({
                where: { id: body.recommendationId, caseId },
                include: { refund: { select: { id: true } } },
              });
            if (!recommendation)
              throw new OpsRefusal(
                "NOT_FOUND",
                "Recommendation not found.",
                404,
              );
            if (
              recommendation.decidedAt &&
              recommendation.approved !== body.approve
            )
              throw new OpsRefusal(
                "ALREADY_DECIDED",
                "This recommendation already has a decision.",
              );
            // Rejecting or returning the existing keyed refund moves no new money.
            return !body.approve || recommendation.refund
              ? 0
              : Number(recommendation.amountPaise);
          })
          .catch(rethrowCaseRefusal);
      },
    },
  },
);
