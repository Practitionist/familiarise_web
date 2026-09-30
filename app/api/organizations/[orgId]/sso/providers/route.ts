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
 *
 * ## Why POST does not call `auth.api.registerSSOProvider`
 *
 * `registerSSOProvider` (BetterAuth's own `POST /sso/register`) is the
 * endpoint that performs registration-time OIDC discovery and writes the
 * canonical `oidcConfig` / `samlConfig` shape. It is unusable for an
 * org-scoped provider at the pinned `@better-auth/sso@1.6.5`, for two
 * independent reasons. Both were read out of the installed package, not
 * inferred:
 *
 *   1. **It stamps the creating user, and the FK cascades.**
 *      `dist/index.mjs:2243` writes `userId: ctx.context.session.user.id`
 *      unconditionally; `ssoProviderBodySchema` (`:1865-1939`) has no field
 *      to override it. `SsoProvider.userId` is an FK with `onDelete:
 *      Cascade` (`prisma/schema.prisma`), so the org's SSO would be deleted
 *      the moment the admin who registered it was removed from the user
 *      table. `scripts/verify-sso-invariants.sh` Check 4 exists specifically
 *      to forbid that, and it is the right call: an org's IdP must outlive
 *      the staff who configured it.
 *
 *   2. **Its discovery step is gated on our own `trustedOrigins`.**
 *      `discoverOIDCConfig` calls `isTrustedOrigin` on the discovery URL
 *      (`:1090-1092`) and on every endpoint it normalizes (`:1176-1184`).
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
 * So the two things `registerSSOProvider` would have given us are obtained
 * directly instead, using the plugin's own exported helpers so nothing here
 * is a divergent re-implementation:
 *
 *   - Discovery: `discoverOidcConfigForTenant` in `lib/sso/oidc-discovery.ts`,
 *     which calls the exported `discoverOIDCConfig` with a tenant-appropriate
 *     trust predicate and the existing SSRF guard. The stored `oidcConfig`
 *     therefore gains `authorizationEndpoint` / `tokenEndpoint` /
 *     `jwksEndpoint` / `userInfoEndpoint` / `tokenEndpointAuthentication`, and
 *     BetterAuth's `needsRuntimeDiscovery` returns false on the sign-in
 *     path, so no discovery fetch happens while a user is waiting to log in.
 *
 *   - Canonical stored shape: `buildStoredSamlConfig` in
 *     `lib/sso/stored-config.ts`. This is not cosmetic — the previous
 *     `{issuer, entryPoint, cert}` shape makes BetterAuth 1.6.5 throw
 *     `TypeError: Cannot read properties of undefined (reading 'metadata')`
 *     at `dist/index.mjs:2447` (sign-in) and `:1851` (SP metadata), because
 *     both dereference `parsedSamlConfig.spMetadata.metadata` with no
 *     optional chaining. Every SAML provider this app has registered was
 *     therefore unable to sign anyone in.
 *
 * On the 1.7 upgrade: re-check whether `registerSSOProvider` gains (a) a way
 * to leave `userId` null for org-scoped providers and (b) a tenant-scoped
 * trust predicate for discovery. If both land, this handler collapses to a
 * single `auth.api.registerSSOProvider` call and `lib/sso/oidc-discovery.ts`
 * and `lib/sso/stored-config.ts` are deleted. If only (a) lands, discovery
 * still has to stay here.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "crypto";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  createProviderSchema,
  isReservedProviderId,
} from "@/lib/sso/provider-schemas";
import { deriveAcsUrl, deriveMetadataUrl } from "@/lib/sso/derive-urls";
import {
  buildStoredOidcConfig,
  discoverOidcConfigForTenant,
  OidcDiscoveryError,
  type DiscoveredOidcConfig,
} from "@/lib/sso/oidc-discovery";
import { buildStoredSamlConfig } from "@/lib/sso/stored-config";
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
      // `samlConfig` and `oidcConfig` are JSON-encoded strings on the
      // `SsoProvider` model (`prisma/schema.prisma`), decrypted and parsed
      // into objects on the way out by the `$extends({ result })` map in
      // `lib/prisma-sso-secret-extension.ts`. We only need to know *which*
      // is populated to drive ACS URL inference below — the contents stay
      // opaque to the list view (the detail endpoint is the one that returns
      // them, redacted for anyone below OWNER). Audit Phase B.2.
      //
      // Only truthiness is read, never a field. That is what keeps this
      // correct across the encryption rollout: a config column is non-null
      // exactly when the admin supplied one, and that is true of a plaintext
      // JSON string, an `sso:v1:` envelope, and the parsed object the
      // extension hands back. Nothing here has to know which.
      samlConfig: true,
      oidcConfig: true,
    },
  });

  // Augment each with its derived ACS + metadata URLs so the dashboard
  // doesn't have to re-compute them client-side. Type inference matters
  // because OIDC providers use a different callback path; the
  // pre-audit-B.2 code hardcoded `null` which always picked the SAML
  // URL — fine for SAML providers, wrong for OIDC providers and very
  // confusing for admins configuring OIDC in their IdP console.
  const augmented = providers.map(({ samlConfig, oidcConfig, ...p }) => {
    const type: "saml" | "oidc" | null = samlConfig
      ? "saml"
      : oidcConfig
        ? "oidc"
        : null;
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
  const access = await requireOrgAccess(orgId, {
    permission: "identity.manage",
  });
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = createProviderSchema.safeParse(raw);
  if (!parsed.success) {
    // A reserved-slug rejection is a 422, not a 400: the body is well-formed
    // and the operator can fix it by choosing a different name, which is the
    // same class of "this conflicts with something that already exists"
    // answer the domain gates below give. The flag lives on the raw body
    // because `safeParse` discards input on failure — re-reading it here
    // keeps the 422/400 decision in one place instead of duplicating the
    // reserved-id set in this route.
    // `typeof … === "string"` rather than `String(…)`. `String({})` is
    // `"[object Object]"`, which is a *truthy* string — so a client posting
    // `{"providerId": {"$ne": null}}` used to produce a provider id that
    // looked well-formed, sailed past `isReservedProviderId`, and reached the
    // uniqueness check as a literal nonsense value instead of a 400.
    const rawProviderId = (raw as { providerId?: unknown } | null)?.providerId;
    const submittedProviderId =
      typeof rawProviderId === "string" ? rawProviderId : "";
    const status = isReservedProviderId(submittedProviderId) ? 422 : 400;
    return NextResponse.json(
      {
        error: "Invalid body",
        detail: parsed.error.flatten(),
        ...(status === 422 ? { code: "PROVIDER_ID_RESERVED" } : {}),
      },
      { status },
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
  // is for: `SsoProvider` carries `@@unique([providerId])` and
  // `@@unique([organizationId, domain])` (see the comment on the model in
  // `prisma/schema.prisma`), so the database refuses the racing insert and
  // the operator still gets a 409-shaped failure. These checks are the fast,
  // explanatory path; the constraints are the load-bearing one.
  try {
    // Domain ownership gate — must come BEFORE the dup-providerId
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

    const dupProviderId = await prisma.ssoProvider.findUnique({
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
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
    throw err;
  }

  // Discovery, now that the org is known to own a verified domain.
  let discoveredOidc: DiscoveredOidcConfig | null = null;
  if (body.providerType === "oidc" && body.oidcConfig) {
    try {
      discoveredOidc = await discoverOidcConfigForTenant(
        body.issuer,
        body.oidcConfig.discoveryEndpoint,
      );
    } catch (err) {
      if (err instanceof OidcDiscoveryError) {
        return NextResponse.json(
          { error: err.message, code: "OIDC_DISCOVERY_FAILED", reason: err.failure },
          { status: 422 },
        );
      }
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { subsystem: "enterprise", op: "sso-oidc-discovery" },
      });
      throw err;
    }
  }

  try {
    const provider = await prisma.$transaction(async (tx) => {
      // Canonical stored shape, built by the two `lib/sso` modules whose
      // headers explain why each field is there. In short: the OIDC config
      // carries the endpoints discovery just resolved (so login never has to
      // fetch them), and the SAML config carries `spMetadata` (without which
      // BetterAuth 1.6.5 throws a TypeError on the sign-in path).
      const storedOidcConfig =
        body.providerType === "oidc" && body.oidcConfig && discoveredOidc
          ? buildStoredOidcConfig({
              issuer: body.issuer,
              clientId: body.oidcConfig.clientId,
              clientSecret: body.oidcConfig.clientSecret,
              discoveryEndpoint: body.oidcConfig.discoveryEndpoint,
              pkce: body.oidcConfig.pkce,
              scopes: body.oidcConfig.scopes,
              discovered: discoveredOidc,
            })
          : null;
      const storedSamlConfig =
        body.providerType === "saml" && body.samlConfig
          ? buildStoredSamlConfig({
              issuer: body.issuer,
              entryPoint: body.samlConfig.entryPoint,
              cert: body.samlConfig.cert,
            })
          : null;

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
          providerId: body.providerId,
          issuer: body.issuer,
          domain: body.domain.toLowerCase(),
          organizationId: orgId,
          // Deliberately NO `userId`. See the module header: the FK cascades
          // on user delete, so binding this row to the registering admin
          // would delete the org's SSO when that person is removed.
          // `scripts/verify-sso-invariants.sh` Check 4 pins this.
          oidcConfig: storedOidcConfig
            ? encryptSecretPayload(storedOidcConfig)
            : null,
          samlConfig: storedSamlConfig
            ? encryptSecretPayload(storedSamlConfig)
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
    const response = gateErrorResponse(err);
    if (response) return response;
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
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
  const code = "code" in err && typeof err.code === "string" ? err.code : undefined;
  return NextResponse.json(
    code ? { error: err.message, code } : { error: err.message },
    { status },
  );
}
