import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { orgPayoutNetPaise } from "@/lib/backoffice/ops-proposal-amounts";
import {
  approveOrgPayout,
  PayoutValidationError,
} from "@/lib/payments/payouts/org-payout-service";
import { PayoutMakerCheckerError } from "@/lib/payments/payouts/shared-lifecycle";

/** A Familiarise admin's co-approval of an org payout the org already approved; ADMIN, step-up, reason. */
export const POST = withOpsAction(
  "payouts.manage",
  "orgPayout.approve",
  {},
  {
    mode: "tx",
    run: async (tx, { params, actor }) => {
      let approved: Awaited<ReturnType<typeof approveOrgPayout>>;
      try {
        approved = await approveOrgPayout(params.id, actor.userId, tx);
      } catch (err) {
        if (err instanceof PayoutMakerCheckerError) {
          throw new OpsRefusal(err.code, err.message, 403);
        }
        if (err instanceof PayoutValidationError) {
          throw new OpsRefusal(
            "ORG_PAYOUT_NOT_APPROVABLE",
            err.message,
            err.httpStatus,
          );
        }
        throw err;
      }
      return {
        target: { kind: "OrganizationPayout", id: params.id },
        before: { status: "PENDING", ...approved },
        after: { status: "APPROVED" },
        response: { status: "APPROVED" },
      };
    },
  },
  {
    stepUp: true,
    secondApprover: {
      route: "/api/admin/org-payouts/[id]/approve",
      target: ({ params }) => ({ kind: "OrganizationPayout", id: params.id }),
      amountPaise: (_body, { params }) => orgPayoutNetPaise(params.id),
    },
  },
);
