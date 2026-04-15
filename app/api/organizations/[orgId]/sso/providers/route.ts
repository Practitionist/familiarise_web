/**
 * SSO providers (SAML / OIDC) for an org.
 *
 * GET  — ORG_OWNER. Lists providers registered through BetterAuth.
 * POST — ORG_OWNER. Registers a new provider linked to this org.
 *
 * The actual provider registration with BetterAuth's plugin is handled
 * server-side via direct Prisma writes to the auto-generated `ssoProvider`
 * table. We tag the row with `organizationId` so the signin domain router in
 * middleware.ts can find the right provider for an incoming domain match.
 *
 * Provider config is normalized to BetterAuth's expected shapes:
 *   - SAML: { issuer, entryPoint, cert } → JSON.stringify'd into samlConfig
 *   - OIDC: { issuer, clientId, clientSecret, discoveryEndpoint, pkce, scopes? } → JSON.stringify'd into oidcConfig
 *
 * `callbackUrl` is intentionally omitted from samlConfig: BetterAuth auto-derives
 * the ACS URL as `{baseURL}/api/auth/sso/saml2/sp/acs/{providerId}`. Letting the
 * admin type a custom URL is a footgun — a mismatch with BetterAuth's derived
 * URL silently breaks SAML assertion delivery. The Add Provider dialog surfaces
 * the derived URL read-only for the IT admin to paste into their IdP.
 *
 * NOTE: BetterAuth SSO auto-provisioning creates a BetterAuth `member` row
 * but NOT the OrganizationMemberProfile the app requires. The customSession
 * callback now auto-repairs missing profiles (see lib/auth.ts), so SSO-
 * provisioned users will get their OrganizationMemberProfile created on
 * first session load.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { createProviderSchema } from "@/lib/sso/provider-schemas";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_OWNER");
    if (access.error) return access.error;

    const rows = await prisma.ssoProvider.findMany({
      where: { organizationId: orgId },
      select: {
        id: true,
        providerId: true,
        issuer: true,
        domain: true,
        samlConfig: true,
        oidcConfig: true,
      },
    });

    // Surface providerType so the UI can show the right ACS / redirect URL.
    const providers = rows.map((r) => ({
      id: r.id,
      providerId: r.providerId,
      issuer: r.issuer,
      domain: r.domain,
      providerType: r.samlConfig ? "saml" : r.oidcConfig ? "oidc" : null,
    }));

    return NextResponse.json({ providers });
  } catch (error) {
    console.error(
      "[API /organizations/[orgId]/sso/providers GET] error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to fetch SSO providers" },
      { status: 500 },
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_OWNER");
    if (access.error) return access.error;

    const body = await req.json();
    const parsed = createProviderSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { providerId, domain, issuer, providerType, samlConfig, oidcConfig } = parsed.data;

    if (providerType === "saml" && !samlConfig) {
      return NextResponse.json(
        { error: "SAML config (issuer, entryPoint, cert) is required for SAML providers." },
        { status: 400 },
      );
    }
    if (providerType === "oidc" && !oidcConfig) {
      return NextResponse.json(
        { error: "OIDC config (issuer, clientId, clientSecret, discoveryEndpoint) is required for OIDC providers." },
        { status: 400 },
      );
    }

    // Store config as JSON strings matching BetterAuth's expected shapes.
    // userId is intentionally omitted — this is an org-scoped provider that
    // must outlive the creating owner. BetterAuth's ssoProvider.userId FK
    // has onDelete: Cascade; binding it to the owner would cascade-delete the
    // provider if the owner's account is ever removed, silently killing SSO
    // for every member of the org.
    const provider = await prisma.ssoProvider.create({
      data: {
        id: crypto.randomUUID(),
        providerId,
        domain,
        issuer,
        organizationId: orgId,
        samlConfig: samlConfig ? JSON.stringify(samlConfig) : null,
        oidcConfig: oidcConfig ? JSON.stringify(oidcConfig) : null,
      },
    });

    return NextResponse.json({ provider }, { status: 201 });
  } catch (error) {
    console.error(
      "[API /organizations/[orgId]/sso/providers POST] error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to register SSO provider" },
      { status: 500 },
    );
  }
}
