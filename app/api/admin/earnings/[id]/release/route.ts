import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { releaseHeldEarnings } from "@/lib/payments/payouts/earnings-hold-ops";

/**
 * #1771 K-3 — release one held earning back to the status it was held FROM:
 * READY when a hold has matured, PENDING when it has not, and PENDING_TRUST
 * when the row was the anti-invoice-fraud park (W1e). Refused while its
 * payment has an open refund or dispute.
 *
 * The audit row must state the status that actually landed. Before W1e this
 * route reported a binary READY/PENDING, so an operator releasing a
 * moderation-held PENDING_TRUST row saw "PENDING" in the log while the row
 * actually went back to PENDING_TRUST — an audit trail that misstates a
 * financial state change.
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
          restored: { ready: ready.length, pending: pending.length, trust: trust.length },
        },
      };
    },
  },
);
