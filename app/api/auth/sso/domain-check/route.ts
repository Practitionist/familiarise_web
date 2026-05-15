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
import { lookupEnforcedOrg } from "@/lib/sso/enforce-session";

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

  // Single source of truth for "is this domain enforced + by which org?"
  // (audit B.6). Returns null when any precondition fails: no verified
  // claim, inactive org, allowlist mismatch, enforceSSO=false. The
  // previous inline lookup here, in `lib/auth.ts:session.create.before`,
  // and in `lib/auth.ts:customSession` each had subtle drift — see
  // issue #673.
  const enforced = await lookupEnforcedOrg(prisma, domain);
  if (!enforced) {
    return NextResponse.json({ enforceSSO: false });
  }

  // Provider lookup is scoped to BOTH (domain, organizationId). The
  // domain-claim is the authoritative "who owns this email domain"
  // record — a stray SsoProvider row for the same domain under a
  // different org (misconfigured tenant, stale data) must not route
  // users to the wrong IdP. (B.4's composite unique now enforces
  // this at the DB level too.)
  const provider = await prisma.ssoProvider.findFirst({
    where: { domain, organizationId: enforced.organizationId },
    select: { providerId: true },
  });
  if (!provider) {
    return NextResponse.json({ enforceSSO: false });
  }

  // The org name is the only extra field this endpoint emits beyond
  // `lookupEnforcedOrg`'s return shape; fetch it now so the SSO button
  // label can show "Sign in with Wipro Limited SSO →".
  const org = await prisma.organization.findUnique({
    where: { id: enforced.organizationId },
    select: { name: true },
  });

  return NextResponse.json({
    enforceSSO: true,
    organizationName: org?.name ?? null,
    ssoBody: {
      providerId: provider.providerId,
      domain,
      callbackURL: `${APP_URL}/auth/signin?ssoCallback=1`,
    },
  });
}
