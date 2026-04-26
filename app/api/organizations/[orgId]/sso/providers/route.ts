/**
 * GET  /api/organizations/[orgId]/sso/providers
 * POST /api/organizations/[orgId]/sso/providers
 *
 * SSO IdP registrations scoped to this organization. Rows live in
 * `SsoProvider` (BetterAuth-managed, not Prisma-owned at auth time — we
 * write it, BetterAuth's sso() plugin reads it). Each row holds the
 * provider-type-specific config as JSON strings (`oidcConfig` /
 * `samlConfig`) so BetterAuth can parse it on login attempts.
 *
 * ACS + metadata URLs are DERIVED from providerId (see
 * lib/sso/derive-urls.ts) — never accepted from the client — so IdP-side
 * setup instructions stay aligned with what BetterAuth actually mounts.
 */

import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "crypto";
import prisma from "@/lib/prisma";
import { requireOrgAccess, requireOrgOwner } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { createProviderSchema } from "@/lib/sso/provider-schemas";
import { deriveAcsUrl, deriveMetadataUrl } from "@/lib/sso/derive-urls";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  const providers = await prisma.ssoProvider.findMany({
    where: { organizationId: orgId },
    select: {
      id: true,
      providerId: true,
      issuer: true,
      domain: true,
      // oidcConfig/samlConfig are redacted in the list view — only the
      // detail endpoint returns them (and even then redacted further).
    },
  });

  // Augment each with its derived ACS + metadata URLs so the dashboard
  // doesn't have to re-compute them client-side.
  const augmented = providers.map((p) => {
    const type: "saml" | "oidc" | null = null;
    return {
      ...p,
      acsUrl: deriveAcsUrl(p.providerId, type),
      metadataUrl: deriveMetadataUrl(p.providerId),
    };
  });

  return NextResponse.json({ data: augmented });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = createProviderSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // Cross-check: providerType-specific config must be present.
  if (body.providerType === "saml" && !body.samlConfig) {
    return NextResponse.json(
      { error: "samlConfig is required for providerType=saml" },
      { status: 400 },
    );
  }
  if (body.providerType === "oidc" && !body.oidcConfig) {
    return NextResponse.json(
      { error: "oidcConfig is required for providerType=oidc" },
      { status: 400 },
    );
  }

  try {
    const provider = await prisma.$transaction(async (tx) => {
      const dupProviderId = await tx.ssoProvider.findUnique({
        where: { providerId: body.providerId },
        select: { id: true },
      });
      if (dupProviderId) {
        throw Object.assign(
          new Error(
            `providerId '${body.providerId}' is already in use. Pick a globally-unique slug.`,
          ),
          { httpStatus: 409 },
        );
      }

      const dupDomain = await tx.ssoProvider.findFirst({
        where: { organizationId: orgId, domain: body.domain.toLowerCase() },
        select: { id: true },
      });
      if (dupDomain) {
        throw Object.assign(
          new Error(
            `Domain '${body.domain}' is already registered with another provider for this org.`,
          ),
          { httpStatus: 409 },
        );
      }

      const created = await tx.ssoProvider.create({
        data: {
          id: randomUUID(),
          providerId: body.providerId,
          issuer: body.issuer,
          domain: body.domain.toLowerCase(),
          organizationId: orgId,
          oidcConfig: body.oidcConfig
            ? JSON.stringify(body.oidcConfig)
            : null,
          samlConfig: body.samlConfig
            ? JSON.stringify(body.samlConfig)
            : null,
        },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SETTINGS",
          action: AUDIT_ACTIONS.SETTINGS.SSO_ENABLED,
          description: `SSO provider '${body.providerId}' (${body.providerType}) registered for domain ${body.domain}`,
          details: {
            providerId: body.providerId,
            providerType: body.providerType,
            domain: body.domain,
            issuer: body.issuer,
          },
        },
      });

      return created;
    });

    return NextResponse.json(
      {
        provider: {
          id: provider.id,
          providerId: provider.providerId,
          issuer: provider.issuer,
          domain: provider.domain,
          acsUrl: deriveAcsUrl(provider.providerId, body.providerType),
          metadataUrl: deriveMetadataUrl(provider.providerId),
        },
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
