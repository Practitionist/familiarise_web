import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { releaseHeldEarnings } from "@/lib/payments/payouts/earnings-hold-ops";

/**
 * #1771 K-3 — release one held earning back to the status it was held FROM
 * (READY/PENDING by hold maturity, or PENDING_TRUST for the W1e park); refused
 * while its payment has an open refund or dispute. The audit row records the
 * status that actually landed.
 */
export const POST = withOpsAction(
  "payouts.manage",
  "earnings.release",
  {},
  {
    mode: "tx",
    run: async (tx, { params, body }) => {
      const { ready, pending, trust } = await releaseHeldEarnings(
        tx,
        [params.id],
        body.reason,
      );
      const status =
        trust.length > 0
          ? "PENDING_TRUST"
          : ready.length > 0
            ? "READY"
            : "PENDING";
      return {
        target: { kind: "ConsultantEarnings", id: params.id },
        before: { status: "HELD" },
        after: { status },
        response: {
          status,
          restored: {
            ready: ready.length,
            pending: pending.length,
            trust: trust.length,
          },
        },
      };
    },
  },
);
