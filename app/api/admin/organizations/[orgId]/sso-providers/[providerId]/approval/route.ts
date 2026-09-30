/**
 * POST /api/admin/organizations/[orgId]/sso-providers/[providerId]/approval
 *
 * D10b — platform staff approve or revoke an org's SSO provider. The sso()
 * plugin (`domainVerification.enabled` in `lib/auth.ts`) refuses sign-in and
 * the OIDC callback for any provider whose `domainVerified` is false, and
 * this door is the only writer that sets it true. A self-service flip would
 * let an org owner route a domain's users to any IdP they control, which is
 * why the plugin's own verify-domain endpoint is disabled.
 *
 * Approval re-checks the DNS TXT proof rather than trusting the create-time
 * check: the claim may have been removed or moved since the provider was
 * registered. ADMIN only (`organizations.manage`), a reason is required, and
 * `withOpsAction` writes the OpsActionLog row in the same transaction.
 */

import { z } from "zod";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";

export const POST = withOpsAction(
  "organizations.manage",
  (body) => (body.approve ? "sso-provider.approve" : "sso-provider.revoke"),
  { approve: z.boolean() },
  {
    mode: "tx",
    run: async (tx, { params, body }) => {
      const provider = await tx.ssoProvider.findFirst({
        where: { providerId: params.providerId, organizationId: params.orgId },
        select: { id: true, domain: true, domainVerified: true },
      });
      if (!provider) {
        throw new OpsRefusal(
          "SSO_PROVIDER_NOT_FOUND",
          "No SSO provider with that id belongs to this organization.",
          404,
        );
      }

      if (body.approve) {
        const claim = await tx.orgDomainClaim.findUnique({
          where: { domain: provider.domain },
          select: { organizationId: true, verifiedAt: true },
        });
        if (claim?.organizationId !== params.orgId || !claim.verifiedAt) {
          throw new OpsRefusal(
            "DOMAIN_NOT_VERIFIED",
            `This organization has no verified DNS claim for ${provider.domain}, so its provider cannot be approved.`,
          );
        }
      }

      await tx.ssoProvider.update({
        where: { id: provider.id },
        data: { domainVerified: body.approve },
      });

      return {
        target: { kind: "SsoProvider", id: provider.id },
        before: { domainVerified: provider.domainVerified },
        after: { domainVerified: body.approve },
        response: {
          providerId: params.providerId,
          domainVerified: body.approve,
        },
      };
    },
  },
);
