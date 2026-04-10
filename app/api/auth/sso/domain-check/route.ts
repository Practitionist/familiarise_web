/**
 * SSO domain check — public endpoint.
 *
 * GET ?email=alice@acme.com
 *
 * Returns whether the email's domain has an SSO provider with enforceSSO=true.
 * The signin page calls this when the user enters their email to decide
 * whether to redirect them to the IdP instead of showing the password form.
 *
 * This replaces the middleware-level domain router because Prisma queries are
 * not edge-compatible. If latency matters, cache the result in Upstash Redis.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const email = searchParams.get("email")?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return NextResponse.json({ enforceSSO: false });
  }

  const domain = email.split("@")[1];

  // Find an org whose SSO settings claim this domain and enforce SSO.
  const ssoSettings = await prisma.organizationSSOSettings.findFirst({
    where: {
      enforceSSO: true,
      allowedEmailDomains: { has: domain },
    },
    select: {
      organizationProfile: {
        select: {
          organizationId: true,
          organization: { select: { name: true, slug: true } },
        },
      },
    },
  });

  if (!ssoSettings) {
    return NextResponse.json({ enforceSSO: false });
  }

  // Look up the SSO provider for this org + domain.
  const provider = await prisma.ssoProvider.findFirst({
    where: {
      organizationId: ssoSettings.organizationProfile.organizationId,
      domain,
    },
    select: { id: true, providerId: true, issuer: true },
  });

  if (!provider) {
    return NextResponse.json({ enforceSSO: false });
  }

  // TODO(SSO): The ssoSignInUrl below assumes BetterAuth exposes a
  // /sign-in/{providerId} path. Verify against the actual plugin routes —
  // BetterAuth SSO may use a body-driven /sign-in/sso endpoint instead.
  return NextResponse.json({
    enforceSSO: true,
    organizationName:
      ssoSettings.organizationProfile.organization.name,
    organizationSlug:
      ssoSettings.organizationProfile.organization.slug,
    providerId: provider.providerId,
    ssoSignInUrl: `/api/auth/sso/sign-in/${provider.providerId}`,
  });
}
