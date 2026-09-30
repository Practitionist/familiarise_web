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
 *
 * One non-payload field rides on every response: the edge's rate-limit
 * degradation flag, echoed from the request. See `degradedEcho` below.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { lookupEnforcedOrg } from "@/lib/sso/enforce-session";

const QuerySchema = z.object({
  email: z.string().email(),
});

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "";

/**
 * The limiter's degradation flag, echoed from the request onto the response.
 *
 * This is the only channel by which the sign-in and sign-up pages can learn that
 * the auth surface is currently running with no rate limiter. The flag itself
 * travels on the *request* header `middleware.ts` stamps — the browser never
 * sees that, because the middleware is upstream of this handler — and the page
 * already fetches this endpoint on email blur, which is the earliest moment on
 * the form where "we have no bot protection right now" is actionable.
 *
 * The value is copied verbatim, never computed, so this route cannot disagree
 * with the edge about whether the limiter is up. Mirrors the constant in
 * `lib/auth/degraded-captcha.ts`; both are pinned to `RATE_LIMIT_DEGRADED_HEADER`
 * by `__tests__/auth/degraded-captcha.test.ts`.
 */
const DEGRADED_HEADER = "x-rate-limit-degraded";

function degradedEcho(req: NextRequest): Record<string, string> {
  return req.headers.get(DEGRADED_HEADER) === "1"
    ? { [DEGRADED_HEADER]: "1" }
    : {};
}

/** `NextResponse.json` that always carries the edge's degradation flag. */
function json(req: NextRequest, body: unknown) {
  return NextResponse.json(body, { headers: degradedEcho(req) });
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    email: url.searchParams.get("email"),
  });
  if (!parsed.success) {
    return json(req, { enforceSSO: false });
  }

  const domain = parsed.data.email.split("@")[1]?.toLowerCase();
  if (!domain) return json(req, { enforceSSO: false });

  // Single source of truth for "is this domain enforced + by which org?"
  // (audit B.6). Returns null when any precondition fails: no verified
  // claim, inactive org, allowlist mismatch, enforceSSO=false. The
  // previous inline lookup here, in `lib/auth.ts:session.create.before`,
  // and in `lib/auth.ts:customSession` each had subtle drift — see
  // issue #673.
  const enforced = await lookupEnforcedOrg(prisma, domain);
  if (!enforced) {
    return json(req, { enforceSSO: false });
  }

  // Provider lookup is scoped to BOTH (domain, organizationId). The
  // domain-claim is the authoritative "who owns this email domain"
  // record — a stray SsoProvider row for the same domain under a
  // different org (misconfigured tenant, stale data) must not route
  // users to the wrong IdP. (B.4's composite unique now enforces
  // this at the DB level too.)
  //
  // Only `providerId` is selected, so the encrypted config column is never
  // decrypted on this pre-auth path.
  const provider = await prisma.ssoProvider.findFirst({
    where: { domain, organizationId: enforced.organizationId },
    select: { providerId: true },
  });
  if (!provider) {
    return json(req, { enforceSSO: false });
  }

  // The org name is the only extra field this endpoint emits beyond
  // `lookupEnforcedOrg`'s return shape; fetch it now so the SSO button
  // label can show "Sign in with Wipro Limited SSO →".
  const org = await prisma.organization.findUnique({
    where: { id: enforced.organizationId },
    select: { name: true },
  });

  // An org-scoped SSO login lands the user IN that org's dashboard, not on
  // their singular-UserRole home. `callbackUrl` is honored by the signin
  // redirect effect for onboarded users and threaded through onboarding for
  // first-timers (relative-path XSS-guarded there). The auto-joined membership
  // is committed in the same customSession request, so the org layout resolves.
  const orgHome = `/dashboard/organization/${enforced.organizationId}/home`;
  return json(req, {
    enforceSSO: true,
    organizationName: org?.name ?? null,
    ssoBody: {
      providerId: provider.providerId,
      domain,
      callbackURL: `${APP_URL}/auth/signin?ssoCallback=1&callbackUrl=${encodeURIComponent(orgHome)}`,
    },
  });
}
