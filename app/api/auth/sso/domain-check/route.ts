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

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { lookupEnforcedOrg } from "@/lib/sso/enforce-session";
import { validateSamlCert } from "@/lib/sso/provider-schemas";
import { SecretPayloadError } from "@/lib/sso/secret-crypto";
import {
  readStoredSamlConfig,
  type StoredConfig,
} from "@/lib/sso/stored-config";

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
  //
  // This query is where the stored config is DECRYPTED. The
  // `$extends({ result })` map in `lib/prisma-sso-secret-extension.ts`
  // runs `decryptSecretPayload` on the two config columns, so
  // `samlConfig` arrives already parsed and already an object. That is
  // why nothing below parses it: the format is the adapter's problem,
  // not this route's.
  //
  // It is also why the try/catch has to wrap the QUERY rather than the
  // cert check. A rotated encryption key, a truncated column, or a
  // key that is simply not mounted throws `SecretPayloadError` out of
  // `findFirst` — before a single line of the check below has run. This
  // endpoint is pre-auth and fires on every email blur, so letting that
  // escape would produce the exact empty-body 500 the guard exists to
  // prevent. Errors that are NOT `SecretPayloadError` (a dead database,
  // a Prisma bug) are re-thrown rather than relabelled: telling a user
  // "your provider is misconfigured" when the database is down sends
  // the admin to fix the wrong thing.
  let provider: { providerId: string; samlConfig: StoredConfig } | null;
  try {
    provider = await prisma.ssoProvider.findFirst({
      where: { domain, organizationId: enforced.organizationId },
      select: { providerId: true, samlConfig: true },
    });
  } catch (error) {
    if (!(error instanceof SecretPayloadError)) throw error;
    Sentry.captureException(error, {
      tags: { subsystem: "auth", op: "sso-domain-check" },
      extra: { failure: error.failure },
    });
    // From the user's side, an unreadable config and a bad certificate are
    // the same situation: this org's SSO cannot be used, so the signin page
    // stays on the credentials form and shows a typed error. The Sentry
    // capture above is the only place the two remain distinguishable.
    return NextResponse.json({
      enforceSSO: true,
      providerMisconfigured: true,
      errorCode: "SSO_PROVIDER_MISCONFIGURED",
    });
  }
  if (!provider) {
    return NextResponse.json({ enforceSSO: false });
  }

  // Pre-flight integrity check on the stored cert. Legacy SsoProvider rows
  // registered before `validateSamlCert` landed in `provider-schemas.ts` may
  // carry a malformed PEM (or none at all). If we hand BetterAuth's SAML
  // adapter a bad cert, it crashes inside `validatePostResponse` with an
  // empty-body 500 — the user clicks "Sign in with SSO" and sees a blank
  // page with no error to act on. Returning the typed
  // `SSO_PROVIDER_MISCONFIGURED` response keeps the signin page on the
  // credentials form and shows a friendly toast.
  //
  // `readStoredSamlConfig` narrows the parsed column field by field, so
  // `cert` is a `string | undefined` rather than an `unknown` — a row whose
  // `cert` is not a string is reported here as "no usable cert" instead of
  // reaching `new X509Certificate(<not a string>)`.
  //
  // OIDC providers don't have a cert; they fail differently (discoveryEndpoint
  // unreachable, etc.) and are out of scope for this guard.
  //
  // The `samlConfig` presence test is load-bearing, not defensive. An OIDC-only
  // provider stores `samlConfig: null`, so `readStoredSamlConfig` returns
  // `null` and the `!saml?.cert` test below would be true — flagging every
  // OIDC provider as misconfigured and refusing OIDC sign-in outright. The
  // "does this provider have a SAML config at all" question and the "is that
  // config's certificate valid" question have to be asked separately, because
  // only the second one has a certificate to be wrong about.
  if (provider.samlConfig) {
    const saml = readStoredSamlConfig(provider.samlConfig);
    if (!saml?.cert || !validateSamlCert(saml.cert)) {
      return NextResponse.json({
        enforceSSO: true,
        providerMisconfigured: true,
        errorCode: "SSO_PROVIDER_MISCONFIGURED",
      });
    }
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
  return NextResponse.json({
    enforceSSO: true,
    organizationName: org?.name ?? null,
    ssoBody: {
      providerId: provider.providerId,
      domain,
      callbackURL: `${APP_URL}/auth/signin?ssoCallback=1&callbackUrl=${encodeURIComponent(orgHome)}`,
    },
  });
}
