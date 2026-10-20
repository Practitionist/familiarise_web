/**
 * PATCH /api/admin/organizations/[orgId]/billing-account
 *
 * The platform's credit door: sets an org's credit limit (null = unlimited)
 * and switches it to INVOICE funding, which a tenant may not do itself.
 * ADMIN only (`invoices.manage`) on a freshly re-authenticated session, a
 * reason is required, and `withOpsAction` writes the OpsActionLog row in the
 * same transaction as the account change.
 */

import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { creditLimitRaisePaise } from "@/lib/backoffice/ops-proposal-amounts";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { recordBillingAccountUpdate } from "@/lib/enterprise/billing-account-audit";
import { assertVerifiedDomainOrThrow } from "@/lib/enterprise/governance";

export const PATCH = withOpsAction(
  "invoices.manage",
  "billing-account.update",
  {
    creditLimit: z.number().int().min(0).nullable().optional(),
    fundingSource: z.literal("INVOICE").optional(),
  },
  {
    mode: "tx",
    run: async (tx, { params, body, actor }) => {
      if (body.creditLimit === undefined && body.fundingSource === undefined) {
        throw new OpsRefusal(
          "NOTHING_TO_CHANGE",
          "Set a credit limit or switch the funding source.",
          400,
        );
      }
      const ba = await tx.billingAccount.findFirst({
        where: { ownerOrgId: params.orgId },
      });
      if (!ba) {
        throw new OpsRefusal(
          "BILLING_ACCOUNT_NOT_FOUND",
          "This organization has no billing account.",
          404,
        );
      }

      const switching =
        body.fundingSource === "INVOICE" && ba.fundingSource !== "INVOICE";
      if (switching) {
        if (ba.fundingSource === "WALLET" && (ba.walletBalance ?? 0) > 0) {
          throw new OpsRefusal(
            "WALLET_BALANCE_NOT_EMPTY",
            "Cannot switch funding source with a non-zero wallet balance. Drain or refund the wallet first.",
          );
        }
        await assertVerifiedDomainOrThrow(tx, params.orgId, "INVOICE_FUNDING");
      }

      // CAS on the values read, so a wallet credit committed after the read is never nulled.
      const cas = await tx.billingAccount.updateMany({
        where: {
          id: ba.id,
          fundingSource: ba.fundingSource,
          walletBalance: ba.walletBalance,
          creditLimit: ba.creditLimit,
        },
        data: {
          ...(switching && { fundingSource: "INVOICE", walletBalance: null }),
          ...(body.creditLimit !== undefined && {
            creditLimit: body.creditLimit,
          }),
        },
      });
      if (cas.count !== 1) {
        throw new OpsRefusal(
          "BILLING_ACCOUNT_CONFLICT",
          "The billing account changed while this ran. Reload and retry.",
        );
      }
      const next = await tx.billingAccount.findUniqueOrThrow({
        where: { id: ba.id },
      });
      await recordBillingAccountUpdate(tx, {
        organizationId: params.orgId,
        // The org's audit page renders this prefix as "Platform admin".
        actorMembershipId: `__admin_stub_${actor.userId}`,
        before: ba,
        after: next,
      });

      return {
        target: { kind: "BillingAccount", id: ba.id },
        before: {
          fundingSource: ba.fundingSource,
          creditLimit: ba.creditLimit,
        },
        after: {
          fundingSource: next.fundingSource,
          creditLimit: next.creditLimit,
        },
        response: { billingAccount: next },
      };
    },
  },
  {
    stepUp: true,
    secondApprover: {
      route: "/api/admin/organizations/[orgId]/billing-account",
      target: ({ params }) => ({ kind: "Organization", id: params.orgId }),
      amountPaise: (body, { params }) =>
        creditLimitRaisePaise(params.orgId, body),
    },
  },
);
