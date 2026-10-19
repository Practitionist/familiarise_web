import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { holdEarnings } from "@/lib/payments/payouts/earnings-hold-ops";

/** #1771 K-3 — place an operator hold on one earning (PENDING|READY → HELD); admin, reason required. */
export const POST = withOpsAction(
  "payouts.manage",
  "earnings.hold",
  {},
  {
    mode: "tx",
    run: async (tx, { params, body, opsActionId }) => {
      const { side, before } = await holdEarnings(
        tx,
        params.id,
        body.reason,
        opsActionId,
      );
      return {
        target: {
          kind:
            side === "consultant"
              ? "ConsultantEarnings"
              : "OrganizationEarnings",
          id: params.id,
        },
        before: { status: before },
        after: { status: "HELD" },
        response: { status: "HELD" },
      };
    },
  },
);
