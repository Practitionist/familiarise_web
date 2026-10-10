/**
 * POST /api/admin/organizations/[orgId]/invoices
 *
 * Platform ops raise a manual invoice for an org (the back-office composer).
 * ADMIN only (`invoices.manage`), a reason is required, and `withOpsAction`
 * writes the OpsActionLog row in the invoice's transaction.
 */

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import {
  createOrgInvoice,
  CreateOrgInvoiceSchema,
  notifyCreatedOrgInvoice,
} from "@/lib/payments/billing/create-org-invoice";
import { getAppUrl } from "@/lib/url";

export const POST = withOpsAction(
  "invoices.manage",
  "org-invoice.create",
  CreateOrgInvoiceSchema.shape,
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
      if (org.status !== "ACTIVE" || !org.canSponsor) {
        throw new OpsRefusal(
          "ORG_NOT_INVOICEABLE",
          "Only an active, sponsoring organization can be invoiced.",
        );
      }

      const created = await createOrgInvoice(tx, {
        orgId: params.orgId,
        // The org's audit page renders this prefix as "Platform admin".
        actorMembershipId: `__admin_stub_${actor.userId}`,
        input: body,
      });
      const { invoice } = created;
      return {
        target: { kind: "OrganizationInvoice", id: invoice.id },
        after: {
          invoiceNumber: invoice.invoiceNumber,
          status: invoice.status,
          totalPaise: invoice.totalPaise,
        },
        response: { invoice },
        status: 201,
        afterCommit: () =>
          notifyCreatedOrgInvoice(getAppUrl(), params.orgId, created, body),
      };
    },
  },
);
