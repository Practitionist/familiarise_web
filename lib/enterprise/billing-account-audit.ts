import type { FundingSource } from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { FUNDING_SOURCE_LABEL } from "@/lib/labels/org-labels";

type AuditedFields = {
  fundingSource: FundingSource;
  currency: string;
  creditLimit: number | null;
  minBalancePaise: number | null;
};

const audited = (ba: AuditedFields) => ({
  fundingSource: ba.fundingSource,
  currency: ba.currency,
  creditLimit: ba.creditLimit,
  minBalancePaise: ba.minBalancePaise,
});

/** A money category, so finance audit readers see it and operations-only readers never see a credit limit. */
export async function recordBillingAccountUpdate(
  tx: Pick<Tx, "orgAuditLog">,
  args: {
    organizationId: string;
    actorMembershipId: string;
    before: AuditedFields;
    after: AuditedFields;
  },
): Promise<void> {
  const { organizationId, actorMembershipId, before, after } = args;
  if (after.fundingSource !== before.fundingSource) {
    await tx.orgAuditLog.create({
      data: {
        organizationId,
        actorMembershipId,
        category: "INVOICE",
        action: AUDIT_ACTIONS.INVOICE.FUNDING_SOURCE_CHANGED,
        description: `Funding source: ${FUNDING_SOURCE_LABEL[before.fundingSource]} → ${FUNDING_SOURCE_LABEL[after.fundingSource]}`,
        details: { from: before.fundingSource, to: after.fundingSource },
      },
    });
  }
  await tx.orgAuditLog.create({
    data: {
      organizationId,
      actorMembershipId,
      category: "INVOICE",
      action: AUDIT_ACTIONS.INVOICE.BILLING_ACCOUNT_UPDATED,
      description: "BillingAccount updated",
      details: { from: audited(before), to: audited(after) },
    },
  });
}
