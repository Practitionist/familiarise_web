/**
 * POST /api/admin/organizations/[orgId]/overages/[overageEventId]/settle-to-org
 *
 * The platform settles a member overage the member never paid, whose base could
 * not go back to the org's accrual (parent already invoiced, or LICENSE-funded),
 * as CHARGE_ORG: it accrues to the org's next rollup and the parent's OVERAGE
 * hold is released. ADMIN only (`invoices.manage`), step-up, reason, OpsActionLog.
 */

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { overageSettlementPaise } from "@/lib/backoffice/ops-proposal-amounts";
import { settleFailedMemberOverageAsOrg } from "@/lib/payments/billing/overage-settlement";

export const POST = withOpsAction(
  "invoices.manage",
  "overage.settle-to-org",
  {},
  {
    mode: "tx",
    run: async (tx, { params }) => {
      const settled = await settleFailedMemberOverageAsOrg(tx, {
        organizationId: params.orgId,
        overageEventId: params.overageEventId,
      });
      return {
        target: { kind: "OverageEvent", id: params.overageEventId },
        before: { overageBehavior: "CHARGE_MEMBER", chargeStatus: "FAILED" },
        after: {
          chargeStatus: "REVERSED",
          childPaymentId: settled.childPaymentId,
          accruedPaise: settled.accruedPaise,
        },
        response: settled,
      };
    },
  },
  {
    stepUp: true,
    secondApprover: {
      route:
        "/api/admin/organizations/[orgId]/overages/[overageEventId]/settle-to-org",
      target: ({ params }) => ({
        kind: "OverageEvent",
        id: params.overageEventId,
      }),
      amountPaise: (_body, { params }) =>
        overageSettlementPaise(params.orgId, params.overageEventId),
    },
  },
);
