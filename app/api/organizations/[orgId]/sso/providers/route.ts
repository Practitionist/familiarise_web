/**
 * GET  /api/organizations/[orgId]/sso/providers
 * POST /api/organizations/[orgId]/sso/providers
 *
 * SSO IdP registrations scoped to this organization. Rows live in
 * `SsoProvider` (BetterAuth-managed, not Prisma-owned at auth time — we
 * write it, BetterAuth's sso() plugin reads it). SSO is OIDC-only: each
 * row holds its config as a JSON string in `oidcConfig` so BetterAuth can
 * parse it on login attempts.
 *
 * `providerId` is generated here (`generateProviderId`), never accepted from
 * the client, so a tenant cannot claim a slug that shadows another sign-in
 * method. The OIDC redirect URI is DERIVED from it (lib/sso/derive-urls.ts),
 * so IdP-side setup instructions stay aligned with what BetterAuth mounts.
 *
 * A new provider is written with `domainVerified: false`, and the sso()
 * plugin refuses sign-in through it until platform staff approve it via
 * app/api/admin/organizations/[orgId]/sso-providers/[providerId]/approval.
 *
 * ## Why POST does not call `auth.api.registerSSOProvider`
 *
 * `registerSSOProvider` (BetterAuth's own `POST /sso/register`) is the
 * endpoint that performs registration-time OIDC discovery and writes the
 * canonical `oidcConfig` shape. It is unusable for an
 * org-scoped provider, for two independent reasons. Both were read out of
 * the installed package (first at 1.6.5, re-checked at 1.7.6), not inferred:
 *
 *   1. **It stamps the creating user, and the FK cascades.**
 *      `dist/index.mjs:3507` (1.7.6) writes
 *      `userId: ctx.context.session.user.id` unconditionally, and the body
 *      schema has no field to override it. `SsoProvider.userId` is an FK with `onDelete:
 *      Cascade` (`prisma/schema.prisma`), so the org's SSO would be deleted
 *      the moment the admin who registered it was removed from the user
 *      table. `scripts/verify-sso-invariants.sh` Check 3 exists specifically
 *      to forbid that, and it is the right call: an org's IdP must outlive
 *      the staff who configured it.
 *
 *   2. **Its discovery step is gated on our own `trustedOrigins`.**
 *      `discoverOIDCConfig` calls `isTrustedOrigin` on the discovery URL
 *      (`validateDiscoveryUrl`, `dist/index.mjs:393-395` at 1.7.6).
 *      BetterAuth resolves that predicate to
 *      `this.trustedOrigins.some(...)`
 *      (`better-auth/dist/context/create-context.mjs:139-141`) — i.e. our own
 *      `BETTER_AUTH_TRUSTED_ORIGINS` (`lib/auth.ts:54-56`, empty by default).
 *      A tenant's IdP is never in that list, so the plugin's own discovery
 *      throws `discovery_untrusted_origin` for every real enterprise IdP.
 *      `skipDiscovery: true` bypasses the check but pushes
 *      authorization/token/JWKS endpoints back onto the admin form, which is
 *      the defect this change exists to fix.
 *
 * So discovery is done directly instead, using the plugin's own exported
 * helper so nothing here is a divergent re-implementation:
 * `discoverOidcConfigForTenant` in `lib/sso/oidc-discovery.ts` calls the
 * exported `discoverOIDCConfig` with a tenant-appropriate trust predicate and
 * the existing SSRF guard. The stored `oidcConfig` therefore gains
 * `authorizationEndpoint` / `tokenEndpoint` / `jwksEndpoint` /
 * `userInfoEndpoint` / `tokenEndpointAuthentication`, and BetterAuth's
 * `needsRuntimeDiscovery` returns false on the sign-in path, so no discovery
 * fetch happens while a user is waiting to log in.
 *
 * Neither changed in 1.7.6, and `/sso/register` is now in `disabledPaths`
 * (`lib/auth.ts`). On each bump, re-check whether `registerSSOProvider` gains
 * (a) a way to leave `userId` null and (b) a tenant-scoped trust predicate
 * for discovery; only with both could this handler collapse into it.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "crypto";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  createProviderSchema,
  generateProviderId,
  isReservedProviderId,
} from "@/lib/sso/provider-schemas";
import { deriveCallbackUrl } from "@/lib/sso/derive-urls";
import {
  buildStoredOidcConfig,
  discoverOidcConfigForTenant,
  OidcDiscoveryError,
  type DiscoveredOidcConfig,
} from "@/lib/sso/oidc-discovery";
import {
  encryptSecretPayload,
  isEncryptionKeyUsable,
} from "@/lib/sso/secret-crypto";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  // #1527 P0-4 — identity.read (OWNER + MAINTAINER), was a MANAGER rank
  // floor that admitted BILLING_ADMIN; secrets stay OWNER-only below.
  const access = await requireOrgAccess(orgId, { permission: "identity.read" });
  if (access.error) return access.error;

  const providers = await prisma.ssoProvider.findMany({
    where: { organizationId: orgId },
    select: {
      id: true,
      providerId: true,
      issuer: true,
      domain: true,
      domainVerified: true,
    },
  });

  // Augment each with its derived redirect URI so the dashboard doesn't
  // have to re-compute it client-side.
  const augmented = providers.map((p) => ({
    ...p,
    callbackUrl: deriveCallbackUrl(p.providerId),
  }));

  return NextResponse.json({ data: augmented });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "identity.manage",
    requireActive: true,
  });
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
  // Any `providerId` in the request body is ignored (zod strips it).
  const providerId = generateProviderId();
  if (isReservedProviderId(providerId)) {
    // Unreachable with the `oidc-` prefix; kept so a future change to the
    // generator cannot silently mint a slug that shadows a sign-in method.
    throw new Error(`generateProviderId produced reserved id ${providerId}`);
  }

  const normalizedDomain = body.domain.toLowerCase();

  // Pre-flight gates — reads only, no transaction and no network.
  //
  // These ran inside the write transaction before OIDC discovery was added.
  // They now run as a separate read phase, for two reasons:
  //
  //   1. Discovery is an outbound fetch to a host the admin chose, with a 10s
  //      timeout (`DEFAULT_DISCOVERY_TIMEOUT`, `dist/index.mjs:1035`). Holding
  //      a Postgres transaction open across it would pin a connection for the
  //      duration of a third party's uptime — the one thing a serverless
  //      function pool cannot afford.
  //   2. More importantly, discovery must not be reachable before the domain
  //      gates pass. Any `identity.manage` member could otherwise make the
  //      platform fetch an arbitrary public URL by submitting a form with
  //      someone else's domain. The SSRF guard in `lib/sso/oidc-discovery.ts`
  //      is what makes that safe at all; requiring a verified domain claim
  //      first is what makes it a non-issue.
  //
  // Splitting the checks from the write does open a TOCTOU window between
  // "no duplicate" and "insert". That is acceptable and is what the schema
  // is for: `SsoProvider` carries `@@unique([organizationId, domain])` (see the comment on the model in
  // `prisma/schema.prisma`), so the database refuses the racing insert and
  // the operator still gets a 409-shaped failure. These checks are the fast,
  // explanatory path; the constraints are the load-bearing one.
  try {
    // Domain ownership gate — must come BEFORE the duplicate-domain
    // check, because a 422 "domain not owned" is the more
    // actionable error to surface for an operator who pasted the
    // wrong domain.
    //
    // Pre-audit-B.3 this org could create an SsoProvider for any
    // domain string. The runtime SSO-enforcement hook at
    // `lib/auth.ts` + `lib/sso/enforce-session.ts` then refused to
    // honor the provider (because no verified OrgDomainClaim
    // existed), but the registration step itself was silent. That
    // "defended by accident" stance leaves the org-admin staring
    // at a registered provider that mysteriously never fires.
    //
    // Explicit gates: 422 DOMAIN_NOT_OWNED if no claim under this
    // org; 422 DOMAIN_NOT_VERIFIED if the claim exists but
    // verifiedAt IS NULL. The auth runtime keeps its
    // belt-and-suspenders check, but now operators see the
    // problem at the point of action.
    const claim = await prisma.orgDomainClaim.findUnique({
      where: { domain: normalizedDomain },
      select: { organizationId: true, verifiedAt: true },
    });
    if (!claim || claim.organizationId !== orgId) {
      throw Object.assign(
        new Error(
          `Domain '${body.domain}' is not claimed by this organization. Claim and verify the domain first under Settings → SSO → Domains.`,
        ),
        { httpStatus: 422, code: "DOMAIN_NOT_OWNED" },
      );
    }
    if (!claim.verifiedAt) {
      throw Object.assign(
        new Error(
          `Domain '${body.domain}' is claimed but not yet verified. Add the required DNS TXT record and complete verification before registering an SSO provider.`,
        ),
        { httpStatus: 422, code: "DOMAIN_NOT_VERIFIED" },
      );
    }

    const dupDomain = await prisma.ssoProvider.findFirst({
      where: { organizationId: orgId, domain: normalizedDomain },
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
  } catch (err) {
    const response = gateErrorResponse(err);
    if (response) return response;
    // Not one of our tagged refusals — the pre-flight's own failure, and one
    // we have no status for. Returning `gateErrorResponse(err)` directly would
    // type the handler as `NextResponse | null`, which Next.js rejects at build
    // time, and silently swallow the error at runtime by returning `null` from
    // a route that has already begun writing headers.
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "enterprise" } },
    );
    throw err;
  }

  // Discovery, now that the org is known to own a verified domain.
  let discoveredOidc: DiscoveredOidcConfig;
  try {
    discoveredOidc = await discoverOidcConfigForTenant(
      body.issuer,
      body.oidcConfig.discoveryEndpoint,
    );
  } catch (err) {
    if (err instanceof OidcDiscoveryError) {
      return NextResponse.json(
        {
          error: err.message,
          code: "OIDC_DISCOVERY_FAILED",
          reason: err.failure,
        },
        { status: 422 },
      );
    }
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      {
        tags: { subsystem: "enterprise", op: "sso-oidc-discovery" },
      },
    );
    throw err;
  }

  try {
    const provider = await prisma.$transaction(async (tx) => {
      // Canonical stored shape: the OIDC config carries the endpoints
      // discovery just resolved, so login never has to fetch them.
      const storedOidcConfig = buildStoredOidcConfig({
        issuer: body.issuer,
        clientId: body.oidcConfig.clientId,
        clientSecret: body.oidcConfig.clientSecret,
        discoveryEndpoint: body.oidcConfig.discoveryEndpoint,
        pkce: body.oidcConfig.pkce,
        scopes: body.oidcConfig.scopes,
        discovered: discoveredOidc,
      });

      // Checked up front rather than discovered by `encryptSecretPayload`
      // throwing mid-write: a malformed key (present, but not 64 hex chars)
      // is a deployment mistake, and the operator should get a named code for
      // it instead of a 500 out of a 201-shaped request.
      if (!isEncryptionKeyUsable()) {
        throw Object.assign(
          new Error(
            "AUTH_CONFIG_ENCRYPTION_KEY is missing or malformed. " +
              "Set it to a 64-character hex string (openssl rand -hex 32).",
          ),
          { httpStatus: 500, code: "SSO_ENCRYPTION_KEY_MISSING" },
        );
      }

      const created = await tx.ssoProvider.create({
        data: {
          id: randomUUID(),
          providerId,
          issuer: body.issuer,
          domain: body.domain.toLowerCase(),
          organizationId: orgId,
          // Stays false until platform staff approve the provider; the
          // sso() plugin refuses sign-in through it until then.
          domainVerified: false,
          // Deliberately NO `userId`. See the module header: the FK cascades
          // on user delete, so binding this row to the registering admin
          // would delete the org's SSO when that person is removed.
          // `scripts/verify-sso-invariants.sh` Check 3 pins this.
          oidcConfig: encryptSecretPayload(storedOidcConfig),
        },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SETTINGS",
          action: AUDIT_ACTIONS.SETTINGS.SSO_ENABLED,
          description: `SSO provider '${providerId}' (${body.providerType}) registered for domain ${body.domain}, awaiting platform approval`,
          details: {
            providerId,
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
          domainVerified: provider.domainVerified,
          callbackUrl: deriveCallbackUrl(provider.providerId),
        },
      },
      { status: 201 },
    );
  } catch (err) {
    const response = gateErrorResponse(err);
    if (response) return response;
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "enterprise" } },
    );
    throw err;
  }
}

/**
 * Turn one of the route's tagged refusals into a response, or `null` for an
 * error that is genuinely ours to report to Sentry.
 *
 * The gates throw `Object.assign(new Error(msg), { httpStatus, code })` so
 * they can be raised from a helper that also has callers outside a
 * `try`/`catch` pair. Both the pre-flight phase and the write phase funnel
 * through here, so the shape of a 409/422 is decided in one place.
 */
function gateErrorResponse(err: unknown): NextResponse | null {
  if (!(err instanceof Error) || !("httpStatus" in err)) return null;
  const status = typeof err.httpStatus === "number" ? err.httpStatus : 500;
  const code =
    "code" in err && typeof err.code === "string" ? err.code : undefined;
  return NextResponse.json(
    code ? { error: err.message, code } : { error: err.message },
    { status },
  );
}
