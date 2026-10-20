import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { holdOrgPayout } from "@/lib/payments/payouts/org-payout-platform-hold";

/** Places a platform hold on a PENDING or APPROVED org payout; the payout run skips it until released. */
export const POST = withOpsAction(
  "payouts.manage",
  "orgPayout.hold",
  {},
  {
    mode: "tx",
    run: async (tx, { params }) => {
      const before = await holdOrgPayout(tx, params.id);
      return {
        target: { kind: "OrganizationPayout", id: params.id },
        before: { status: before },
        after: { platformHeld: true },
        response: { held: true },
      };
    },
  },
  { stepUp: true },
);
