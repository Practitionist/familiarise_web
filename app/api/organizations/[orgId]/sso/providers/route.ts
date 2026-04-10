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
 * TODO(SSO): This route writes raw samlConfig/oidcConfig strings into the
 * ssoProvider table. BetterAuth's SSO plugin may expect structured JSON or
 * specific fields in these columns at runtime. Before enabling real SSO
 * sign-in, normalize provider config into the exact shape the plugin expects:
 *   - SAML: parse XML metadata into entityId, ssoUrl, certificate, etc.
 *   - OIDC: store { clientId, clientSecret, issuer, authorizationUrl, ... }
 * Also: BetterAuth SSO auto-provisioning creates a BetterAuth `member` row
 * but NOT the OrganizationMemberProfile the app requires. Until a sync hook
 * is added, SSO-provisioned users will authenticate but get 403 from
 * requireOrgAccess(). See PR #655 review feedback for details.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

const createProviderSchema = z.object({
  providerId: z
    .string()
    .trim()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/i, "providerId must be alphanumeric"),
  domain: z.string().trim().min(3).max(255),
  issuer: z.string().trim().min(1).max(500),
  samlConfig: z.string().optional(), // SAML metadata XML
  oidcConfig: z.string().optional(), // OIDC discovery JSON
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_OWNER");
    if (access.error) return access.error;

    const providers = await prisma.ssoProvider.findMany({
      where: { organizationId: orgId },
      select: {
        id: true,
        providerId: true,
        issuer: true,
        domain: true,
      },
    });

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

    const { providerId, domain, issuer, samlConfig, oidcConfig } = parsed.data;
    if (!samlConfig && !oidcConfig) {
      return NextResponse.json(
        { error: "Either samlConfig (SAML XML) or oidcConfig (OIDC JSON) is required." },
        { status: 400 },
      );
    }

    const provider = await prisma.ssoProvider.create({
      data: {
        id: crypto.randomUUID(),
        providerId,
        domain,
        issuer,
        organizationId: orgId,
        samlConfig: samlConfig ?? null,
        oidcConfig: oidcConfig ?? null,
        userId: access.session.user.id,
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
