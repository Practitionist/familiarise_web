import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { releaseOrgPayoutHold } from "@/lib/payments/payouts/org-payout-platform-hold";

/** Clears the platform hold, so the next payout run may send the payout. */
export const POST = withOpsAction(
  "payouts.manage",
  "orgPayout.release",
  {},
  {
    mode: "tx",
    run: async (tx, { params }) => {
      const status = await releaseOrgPayoutHold(tx, params.id);
      return {
        target: { kind: "OrganizationPayout", id: params.id },
        before: { status, platformHeld: true },
        after: { platformHeld: false },
        response: { held: false },
      };
    },
  },
  { stepUp: true },
);
