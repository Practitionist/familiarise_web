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
 * Approval re-checks that every covered domain still has a verified DNS claim
 * of this org. ADMIN only (`organizations.manage`), a reason is required,
 * `withOpsAction` writes the OpsActionLog row in the same transaction, and the
 * org's OWNERs are emailed after commit.
 */

import { z } from "zod";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { sendSsoProviderDecisionEmail } from "@/lib/email";
import { providerDomains } from "@/lib/sso/domains";

export const POST = withOpsAction(
  "organizations.manage",
  (body) => (body.approve ? "sso-provider.approve" : "sso-provider.revoke"),
  { approve: z.boolean() },
  {
    mode: "tx",
    run: async (tx, { params, body }) => {
      const provider = await tx.ssoProvider.findFirst({
        where: { providerId: params.providerId, organizationId: params.orgId },
        select: {
          id: true,
          domain: true,
          issuer: true,
          domainVerified: true,
          organization: { select: { name: true } },
        },
      });
      if (!provider) {
        throw new OpsRefusal(
          "SSO_PROVIDER_NOT_FOUND",
          "No SSO provider with that id belongs to this organization.",
          404,
        );
      }

      const domains = providerDomains(provider.domain);
      if (body.approve) {
        const verified = await tx.orgDomainClaim.findMany({
          where: {
            organizationId: params.orgId,
            domain: { in: domains },
            verifiedAt: { not: null },
          },
          select: { domain: true },
        });
        const missing = domains.filter(
          (d) => !verified.some((c) => c.domain === d),
        );
        if (missing.length > 0) {
          throw new OpsRefusal(
            "DOMAIN_NOT_VERIFIED",
            `This organization has no verified DNS claim for ${missing.join(", ")}, so its provider cannot be approved.`,
          );
        }
      } else if (provider.domainVerified) {
        // Same rule as the org-side delete: enforcement with no approved
        // provider fails open, so revoking the last one would silently undo it.
        const settings = await tx.organizationSSOSettings.findUnique({
          where: { organizationId: params.orgId },
          select: { enforceSSO: true },
        });
        const approved = settings?.enforceSSO
          ? await tx.ssoProvider.count({
              where: { organizationId: params.orgId, domainVerified: true },
            })
          : Infinity;
        if (approved <= 1) {
          throw new OpsRefusal(
            "LAST_APPROVED_SSO_PROVIDER",
            "This is the organization's last approved provider and SSO is enforced. Turn enforcement off first.",
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
        afterCommit: () =>
          sendSsoProviderDecisionEmail({
            organizationId: params.orgId,
            orgName: provider.organization?.name ?? "your organisation",
            providerId: params.providerId,
            domains,
            issuer: provider.issuer,
            reason: body.reason,
            approved: body.approve,
          }),
      };
    },
  },
);
