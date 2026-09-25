import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { releaseHeldEarnings } from "@/lib/payments/payouts/earnings-hold-ops";

/**
 * #1771 K-3 — release one held earning: READY when its hold has matured,
 * PENDING otherwise; refused while its payment has an open refund or dispute.
 */
export const POST = withOpsAction(
  "payouts.manage",
  "earnings.release",
  {},
  {
    mode: "tx",
    run: async (tx, { params, body }) => {
      const { ready } = await releaseHeldEarnings(tx, [params.id], body.reason);
      const status = ready.length > 0 ? "READY" : "PENDING";
      return {
        target: { kind: "ConsultantEarnings", id: params.id },
        before: { status: "HELD" },
        after: { status },
        response: { status },
      };
    },
  },
);
