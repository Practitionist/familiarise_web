/**
 * POST /api/admin/organizations/[orgId]/sso-enforcement
 *
 * Platform staff turn an org's SSO enforcement on or off. Off is the recovery
 * path when the org's IdP breaks: with enforcement on, its users can only
 * sign in through the SSO callback, and an org owner locked out by a broken
 * IdP cannot reach their own settings page to switch it off.
 *
 * Turning it on needs an approved provider, as on the org's own settings
 * route. ADMIN only (`organizations.manage`), a reason is required, and
 * `withOpsAction` writes the OpsActionLog row in the same transaction.
 */

import { z } from "zod";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";

export const POST = withOpsAction(
  "organizations.manage",
  (body) =>
    body.enforce ? "sso-enforcement.enable" : "sso-enforcement.disable",
  { enforce: z.boolean() },
  {
    mode: "tx",
    run: async (tx, { params, body }) => {
      const org = await tx.organization.findUnique({
        where: { id: params.orgId },
        select: { id: true },
      });
      if (!org) {
        throw new OpsRefusal(
          "ORGANIZATION_NOT_FOUND",
          "No organization with that id.",
          404,
        );
      }

      if (body.enforce) {
        const approved = await tx.ssoProvider.count({
          where: { organizationId: params.orgId, domainVerified: true },
        });
        if (approved === 0) {
          throw new OpsRefusal(
            "NO_APPROVED_SSO_PROVIDER",
            "Approve one of this organization's SSO providers before enforcing SSO.",
          );
        }
      }

      const before = await tx.organizationSSOSettings.findUnique({
        where: { organizationId: params.orgId },
        select: { enforceSSO: true },
      });
      const settings = await tx.organizationSSOSettings.upsert({
        where: { organizationId: params.orgId },
        create: { organizationId: params.orgId, enforceSSO: body.enforce },
        update: { enforceSSO: body.enforce, version: { increment: 1 } },
        select: { id: true },
      });

      return {
        target: { kind: "OrganizationSSOSettings", id: settings.id },
        before: { enforceSSO: before?.enforceSSO ?? false },
        after: { enforceSSO: body.enforce },
        response: { enforceSSO: body.enforce },
      };
    },
  },
);
