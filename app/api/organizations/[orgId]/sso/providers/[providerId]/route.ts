/**
 * GET    /api/organizations/[orgId]/sso/providers/[providerId]
 * DELETE /api/organizations/[orgId]/sso/providers/[providerId]
 *
 * Detail + delete for a single SSO provider registration. PATCH is NOT
 * offered — identity-provider config edits are risky (a silent typo in
 * `entryPoint` or `cert` locks users out), so the UX is delete-and-recreate.
 *
 * The URL path uses the human `providerId` slug, not the internal row
 * uuid, to match the IdP-side setup flow (admins copy the slug into their
 * IdP's metadata).
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess, requireOrgOwner } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { deriveAcsUrl, deriveMetadataUrl } from "@/lib/sso/derive-urls";

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; providerId: string }>;
  },
) {
  const { orgId, providerId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  const provider = await prisma.ssoProvider.findFirst({
    where: { providerId, organizationId: orgId },
  });
  if (!provider) {
    return NextResponse.json(
      { error: "SSO provider not found" },
      { status: 404 },
    );
  }

  // Only OWNER roles get the full config JSON in the payload. Lower
  // roles see redacted markers — cert/client-secret values would leak
  // sensitive IdP credentials otherwise.
  const isOwner = access.member.role === "OWNER";
  const type: "saml" | "oidc" | null = provider.samlConfig
    ? "saml"
    : provider.oidcConfig
      ? "oidc"
      : null;

  return NextResponse.json({
    provider: {
      id: provider.id,
      providerId: provider.providerId,
      issuer: provider.issuer,
      domain: provider.domain,
      providerType: type,
      acsUrl: deriveAcsUrl(provider.providerId, type),
      metadataUrl: deriveMetadataUrl(provider.providerId),
      oidcConfig: isOwner
        ? provider.oidcConfig
        : provider.oidcConfig
          ? "[redacted]"
          : null,
      samlConfig: isOwner
        ? provider.samlConfig
        : provider.samlConfig
          ? "[redacted]"
          : null,
    },
  });
}

export async function DELETE(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; providerId: string }>;
  },
) {
  const { orgId, providerId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.ssoProvider.findFirst({
        where: { providerId, organizationId: orgId },
      });
      if (!current) {
        throw Object.assign(new Error("SSO provider not found"), {
          httpStatus: 404,
        });
      }

      // Refuse if removing the last provider would leave the org in an
      // inconsistent state — enforceSSO=true with zero providers and no
      // allowed domains would lock every user out. Admins must drop
      // enforcement or add a domain first.
      const settings = await tx.organizationSSOSettings.findUnique({
        where: { organizationId: orgId },
      });
      if (settings?.enforceSSO) {
        const remaining = await tx.ssoProvider.count({
          where: { organizationId: orgId, id: { not: current.id } },
        });
        const effectiveDomains = settings.allowedEmailDomains ?? [];
        if (remaining === 0 && effectiveDomains.length === 0) {
          throw Object.assign(
            new Error(
              "Cannot delete the last SSO provider while enforceSSO=true and no allowed domains. Disable enforcement or add a domain first.",
            ),
            { httpStatus: 409 },
          );
        }
      }

      await tx.ssoProvider.delete({ where: { id: current.id } });

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SETTINGS",
          action: AUDIT_ACTIONS.SETTINGS.SSO_DISABLED,
          description: `SSO provider '${providerId}' removed`,
          details: {
            providerId,
            domain: current.domain,
            issuer: current.issuer,
          },
        },
      });
    });

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
