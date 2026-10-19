/**
 * POST /api/admin/payout-accounts/unfreeze — lifts a payee's payout freeze
 * placed from the bank-change email. ADMIN, step-up, a reason and an ops log row.
 */

import { z } from "zod";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal";

export const POST = withOpsAction(
  "payouts.manage",
  "payoutAccount.unfreeze",
  {
    payee: z.enum(["CONSULTANT", "ORG"]),
    payeeId: z.string().min(1),
  },
  {
    mode: "tx",
    run: async (tx, { body }) => {
      const lifted =
        body.payee === "CONSULTANT"
          ? await tx.payoutAccount.updateMany({
              where: {
                consultantProfileId: body.payeeId,
                payoutsFrozenAt: { not: null },
              },
              data: { payoutsFrozenAt: null },
            })
          : await tx.organizationPayoutAccount.updateMany({
              where: {
                organizationId: body.payeeId,
                payoutsFrozenAt: { not: null },
              },
              data: { payoutsFrozenAt: null },
            });
      if (lifted.count === 0) {
        throw new OpsRefusal(
          "NOT_FROZEN",
          "Payouts are not frozen for this payee.",
          409,
        );
      }
      const kind =
        body.payee === "CONSULTANT" ? "ConsultantProfile" : "Organization";
      return {
        target: { kind, id: body.payeeId },
        before: { frozen: true },
        after: { frozen: false, accounts: lifted.count },
        response: { unfrozen: lifted.count },
      };
    },
  },
  { stepUp: true },
);
