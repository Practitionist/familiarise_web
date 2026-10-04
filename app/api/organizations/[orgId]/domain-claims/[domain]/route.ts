/**
 * DELETE /api/organizations/[orgId]/domain-claims/[domain]
 *
 * Releases a previously-claimed domain. The URL path uses the domain
 * string directly (after URI-decode) rather than the row uuid, so an
 * admin can hit `DELETE .../domain-claims/wipro.com` without first having
 * to look up the row id.
 *
 * Releasing revokes the approval of the org's SSO providers for this domain
 * (D21), and is refused when that would leave SSO enforced with no approved
 * provider.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

export async function DELETE(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; domain: string }>;
  },
) {
  const { orgId, domain: rawDomain } = await params;
  const domain = decodeURIComponent(rawDomain).toLowerCase().trim();
  const access = await requireOrgAccess(orgId, {
    permission: "identity.manage",
    requireActive: true,
  });
  if (access.error) return access.error;

  try {
    await prisma.$transaction(async (tx) => {
      const claim = await tx.orgDomainClaim.findUnique({
        where: { domain },
      });
      if (!claim || claim.organizationId !== orgId) {
        throw Object.assign(new Error("Domain claim not found"), {
          httpStatus: 404,
        });
      }

      // A provider's approval rests on this claim, so releasing it revokes
      // the approval in the same transaction; re-claiming needs fresh DNS
      // proof and a fresh staff approval.
      const approved = await tx.ssoProvider.findMany({
        where: { organizationId: orgId, domainVerified: true },
        select: { providerId: true, domain: true },
      });
      const unapproved = approved
        .filter((p) => p.domain === domain)
        .map((p) => p.providerId);
      if (unapproved.length > 0 && unapproved.length === approved.length) {
        const settings = await tx.organizationSSOSettings.findUnique({
          where: { organizationId: orgId },
          select: { enforceSSO: true },
        });
        // Same rule as deleting the last approved provider.
        if (settings?.enforceSSO) {
          throw Object.assign(
            new Error(
              "Releasing this domain would revoke the last approved SSO provider while SSO is enforced. Disable enforcement first.",
            ),
            { httpStatus: 409 },
          );
        }
      }

      await tx.orgDomainClaim.delete({ where: { domain } });
      if (unapproved.length > 0) {
        await tx.ssoProvider.updateMany({
          where: { organizationId: orgId, domain },
          data: { domainVerified: false },
        });
      }

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SETTINGS",
          action: AUDIT_ACTIONS.SETTINGS.DOMAIN_RELEASED,
          description:
            unapproved.length > 0
              ? `Domain '${domain}' released; SSO provider approval revoked for ${unapproved.join(", ")}`
              : `Domain '${domain}' released`,
          details: { domain, unapprovedProviderIds: unapproved },
        },
      });
    });

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status = typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "organizations" } },
    );
    throw err;
  }
}
