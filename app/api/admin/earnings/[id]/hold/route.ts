import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { holdEarnings } from "@/lib/payments/payouts/earnings-hold-ops";

/** #1771 K-3 — hold one earning (PENDING|READY → HELD); admin, reason required. */
export const POST = withOpsAction(
  "payouts.manage",
  "earnings.hold",
  {},
  {
    mode: "tx",
    run: async (tx, { params, body }) => {
      const { before } = await holdEarnings(tx, [params.id], body.reason);
      return {
        target: { kind: "ConsultantEarnings", id: params.id },
        before: { status: before[0]?.status ?? null },
        after: { status: "HELD" },
        response: { status: "HELD" },
      };
    },
  },
);
