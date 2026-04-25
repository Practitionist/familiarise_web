/**
 * GET /api/auth/sso/domain-check?email=<email>
 *
 * Pre-auth discovery endpoint. The signin/signup pages call this on
 * email blur so an enforce-SSO domain can short-circuit the credentials
 * form and redirect to the IdP via BetterAuth's `signIn.sso()`.
 *
 * Lookup chain (all Arch 4-Modified — no legacy org profile tables):
 *   1. Parse + narrow the email query param (Zod).
 *   2. Match the email's domain against `OrgDomainClaim`.
 *   3. For the owning org, read `OrganizationSSOSettings` + the first
 *      active `SsoProvider`.
 *   4. Return `{ enforceSSO, organizationName?, ssoBody? }`. If the
 *      domain isn't claimed, or the org doesn't enforce SSO, or no
 *      provider is configured, return `{ enforceSSO: false }` so the
 *      client falls through to the normal credentials flow.
 *
 * Intentionally does NOT use `requireApiAuth` — this runs before login.
 * The response payload is shaped to be minimal (no PII, no provider
 * internals) so leaking it to unauthenticated callers is safe.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";

const QuerySchema = z.object({
  email: z.string().email(),
});

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    email: url.searchParams.get("email"),
  });
  if (!parsed.success) {
    return NextResponse.json({ enforceSSO: false });
  }

  const domain = parsed.data.email.split("@")[1]?.toLowerCase();
  if (!domain) return NextResponse.json({ enforceSSO: false });

  const claim = await prisma.orgDomainClaim.findUnique({
    where: { domain },
    select: {
      organizationId: true,
      verifiedAt: true,
      organization: {
        select: {
          name: true,
          status: true,
          ssoSettings: {
            select: { enforceSSO: true, allowedEmailDomains: true },
          },
        },
      },
    },
  });

  // Unverified claims (no DNS TXT proof) must not steer users into SSO —
  // a malicious OWNER could otherwise claim `gmail.com` and intercept
  // the domain-check redirect for anyone whose email matches.
  if (
    !claim ||
    !claim.verifiedAt ||
    !claim.organization ||
    claim.organization.status !== "ACTIVE" ||
    !claim.organization.ssoSettings?.enforceSSO
  ) {
    return NextResponse.json({ enforceSSO: false });
  }

  // A `domainClaim` row exists, but if the org also curates an allowlist
  // we honour it so a caught-in-transition domain (owned by the org but
  // temporarily excluded) can't force SSO on someone.
  const allowed = claim.organization.ssoSettings.allowedEmailDomains;
  if (allowed.length > 0 && !allowed.includes(domain)) {
    return NextResponse.json({ enforceSSO: false });
  }

  // Provider lookup is scoped to BOTH (domain, organizationId). The
  // domain-claim is the authoritative "who owns this email domain"
  // record — a stray SsoProvider row for the same domain under a
  // different org (misconfigured tenant, stale data) must not route
  // users to the wrong IdP.
  const provider = await prisma.ssoProvider.findFirst({
    where: { domain, organizationId: claim.organizationId },
    select: { providerId: true },
  });
  if (!provider) {
    return NextResponse.json({ enforceSSO: false });
  }

  return NextResponse.json({
    enforceSSO: true,
    organizationName: claim.organization.name,
    ssoBody: {
      providerId: provider.providerId,
      domain,
      callbackURL: `${APP_URL}/auth/signin?ssoCallback=1`,
    },
  });
}
