import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { releaseHeldEarnings } from "@/lib/payments/payouts/earnings-hold-ops";

/**
 * #1771 K-3 — release the operator and moderation holds on one earning; refused
 * while its payment has an open refund or dispute. The earning leaves HELD only
 * when no other hold remains, and the audit row records the status that landed.
 */
export const POST = withOpsAction(
  "payouts.manage",
  "earnings.release",
  {},
  {
    mode: "tx",
    run: async (tx, { params, body, actor }) => {
      const { side, status } = await releaseHeldEarnings(
        tx,
        params.id,
        body.reason,
        actor.userId,
      );
      return {
        target: {
          kind:
            side === "consultant"
              ? "ConsultantEarnings"
              : "OrganizationEarnings",
          id: params.id,
        },
        before: { status: "HELD" },
        after: { status },
        response: { status },
      };
    },
  },
);
