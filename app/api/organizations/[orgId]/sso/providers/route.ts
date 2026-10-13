/**
 * GET  /api/organizations/[orgId]/sso/providers
 * POST /api/organizations/[orgId]/sso/providers
 *
 * Org-scoped OIDC provider registrations. The server generates `providerId`,
 * runs discovery (lib/sso/oidc-discovery.ts) and stores the encrypted config
 * with `domainVerified: false`; staff approve it through the ADMIN door. A
 * provider may cover several of the org's verified domains (comma-separated
 * `domain`, as the sso() plugin reads it) and `userId` stays null.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "crypto";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { scheduleAfter } from "@/lib/api/after-safe";
import { sendSsoProviderSubmittedEmail } from "@/lib/email";
import {
  createProviderSchema,
  generateProviderId,
} from "@/lib/sso/provider-schemas";
import { deriveCallbackUrl } from "@/lib/sso/derive-urls";
import { providerDomains, serializeProviderDomains } from "@/lib/sso/domains";
import { assertProviderDomains } from "@/lib/sso/provider-coverage";
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
  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    permission: "identity.read",
  });
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
  const storedDomain = serializeProviderDomains(body.domains);
  const domains = providerDomains(storedDomain);

  // Read-only gates before discovery, so no outbound fetch happens for a
  // domain the org has not proven; re-checked in the write transaction.
  try {
    await assertProviderDomains(prisma, orgId, domains);
  } catch (err) {
    const response = gateErrorResponse(err);
    if (response) return response;
    throw err;
  }

  // Discovery, now that the org is known to own every domain.
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
      await assertProviderDomains(tx, orgId, domains);
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
          domain: storedDomain,
          organizationId: orgId,
          domainVerified: false,
          oidcConfig: encryptSecretPayload(
            buildStoredOidcConfig({
              issuer: body.issuer,
              clientId: body.oidcConfig.clientId,
              clientSecret: body.oidcConfig.clientSecret,
              discoveryEndpoint: body.oidcConfig.discoveryEndpoint,
              discovered: discoveredOidc,
            }),
          ),
        },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SETTINGS",
          action: AUDIT_ACTIONS.SETTINGS.SSO_ENABLED,
          description: `SSO provider '${providerId}' (${body.providerType}) registered for ${domains.join(", ")}, awaiting platform approval`,
          details: {
            providerId,
            providerType: body.providerType,
            domains,
            issuer: body.issuer,
          },
        },
      });

      return created;
    });

    scheduleAfter(
      () =>
        sendSsoProviderSubmittedEmail({
          organizationId: orgId,
          orgName: access.org.name,
          providerId,
          domains,
          issuer: body.issuer,
        }),
      "sso.provider-submitted-email",
    );

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

/** A tagged `{ httpStatus, code }` refusal as a response, or null for a real fault. */
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
