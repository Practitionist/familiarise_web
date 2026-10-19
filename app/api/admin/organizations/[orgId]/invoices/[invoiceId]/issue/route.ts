/**
 * POST /api/admin/organizations/[orgId]/invoices/[invoiceId]/issue
 *
 * The platform issues a DRAFT invoice, naming the purchase order it draws on
 * when the org requires one (a rollup or subscription invoice no PO covered).
 * ADMIN only (`invoices.manage`), step-up, reason, one OpsActionLog row in the tx.
 */

import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import {
  issueDraftOrgInvoice,
  notifyIssuedOrgInvoice,
} from "@/lib/payments/billing/create-org-invoice";
import { getAppUrl } from "@/lib/url";

export const POST = withOpsAction(
  "invoices.manage",
  "org-invoice.issue-draft",
  { purchaseOrderId: z.string().min(1).nullable().default(null) },
  {
    mode: "tx",
    run: async (tx, { params, body, actor }) => {
      const org = await tx.organization.findUnique({
        where: { id: params.orgId },
        select: { status: true, canSponsor: true },
      });
      if (!org) {
        throw new OpsRefusal(
          "ORGANIZATION_NOT_FOUND",
          "No organization with that id.",
          404,
        );
      }
      if (
        !org.canSponsor ||
        (org.status !== "ACTIVE" && org.status !== "PENDING_VERIFICATION")
      ) {
        throw new OpsRefusal(
          "ORG_NOT_INVOICEABLE",
          "Only an active or verifying sponsoring organization can be invoiced.",
        );
      }
      const issued = await issueDraftOrgInvoice(tx, {
        orgId: params.orgId,
        invoiceId: params.invoiceId,
        purchaseOrderId: body.purchaseOrderId,
        actorMembershipId: `__admin_stub_${actor.userId}`,
      });
      return {
        target: { kind: "OrganizationInvoice", id: issued.invoiceId },
        before: { status: "DRAFT" },
        after: {
          status: "ISSUED",
          purchaseOrderId: issued.purchaseOrderId,
          dueDate: issued.dueDate.toISOString(),
        },
        response: {
          invoiceId: issued.invoiceId,
          purchaseOrderId: issued.purchaseOrderId,
          dueDate: issued.dueDate.toISOString(),
        },
        afterCommit: () =>
          notifyIssuedOrgInvoice(getAppUrl(), params.orgId, issued),
      };
    },
  },
  { stepUp: true },
);
