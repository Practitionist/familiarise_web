/**
 * GET    /api/organizations/[orgId]/sso/providers/[providerId]
 * DELETE /api/organizations/[orgId]/sso/providers/[providerId]
 *
 * Detail + delete for a single SSO provider registration. PATCH is NOT
 * offered — identity-provider config edits are risky (a silent typo in
 * `clientId` or `clientSecret` locks users out), so the UX is
 * delete-and-recreate.
 *
 * The URL path uses the `providerId` slug, not the internal row uuid, to
 * match the IdP-side setup flow (the slug is part of the redirect URI).
 *
 * The IdP client secret is write-only: no role ever gets it back. It is
 * entered once at create and a mistake is fixed by delete-and-recreate, so
 * returning it serves no flow and only widens what a hijacked OWNER session
 * or a logged response can leak.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { deriveCallbackUrl } from "@/lib/sso/derive-urls";
import { redactOidcConfig } from "@/lib/sso/redact-oidc-config";
import { notifyOrgSsoProviderDeleted } from "@/lib/novu/org-workflows";
import type { SecretPayloadFailure } from "@/lib/sso/secret-crypto";
import { readOidcConfig } from "@/lib/prisma-sso-secret-extension";

/**
 * The message an OWNER sees when their provider's config cannot be read.
 *
 * Two cases, kept apart because they need opposite responses from the
 * operator. A missing key is ours to fix and re-entering the IdP details
 * will not help; anything else (wrong key, truncated column, non-JSON
 * garbage) is almost always a row the admin can repair themselves, and
 * telling them to contact support for a self-inflicted problem wastes a
 * round trip.
 */
function unreadableConfigError(failure: SecretPayloadFailure): string {
  return failure === "key_unavailable"
    ? "Server configuration error: the SSO encryption key is not available, so this provider's settings cannot be shown. Contact support."
    : "This provider's stored configuration could not be read, so it cannot be shown or used. It most likely needs to be re-entered.";
}

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; providerId: string }>;
  },
) {
  const { orgId, providerId } = await params;
  // #1527 P0-4 — identity.read (OWNER + MAINTAINER), was a MANAGER rank
  // floor that admitted BILLING_ADMIN. Both roles get the same redacted view.
  const access = await requireOrgAccess(orgId, { permission: "identity.read" });
  if (access.error) return access.error;

  // Decryption happens lazily when `oidcConfig` is read, so the read goes
  // through `readOidcConfig` rather than relying on a try around the query.
  //
  // An unreadable config is a 200 with `providerMisconfigured`, not an error
  // status: the settings page must still list the provider so the admin can
  // see which IdP is broken.
  const provider = await findProvider(providerId, orgId);
  if (!provider) {
    return NextResponse.json(
      { error: "SSO provider not found" },
      { status: 404 },
    );
  }

  const read = readOidcConfig(provider);
  let configError: string | null = null;
  if (read.failure) {
    Sentry.captureException(read.error, {
      tags: { subsystem: "enterprise", op: "sso-provider-read" },
      extra: { failure: read.failure },
    });
    configError = unreadableConfigError(read.failure);
  }
  const oidcConfig = read.config;

  const type: "oidc" | null = oidcConfig ? "oidc" : null;

  // A provider row with no config is a half-written record. Fabricating a
  // `callbackUrl` for it would write a misleading value into the admin UI;
  // return null instead so the page can render the "configuration
  // incomplete" state correctly.
  const callbackUrl = type ? deriveCallbackUrl(provider.providerId) : null;

  return NextResponse.json({
    provider: {
      id: provider.id,
      providerId: provider.providerId,
      issuer: provider.issuer,
      domain: provider.domain,
      domainVerified: provider.domainVerified,
      providerType: type,
      callbackUrl,
      oidcConfig: redactOidcConfig(oidcConfig),
      ...(configError
        ? {
            providerMisconfigured: true,
            errorCode: "SSO_PROVIDER_MISCONFIGURED",
            error: configError,
          }
        : {}),
    },
  });
}

/**
 * The provider row; `oidcConfig` decrypts when read. `select` is explicit so
 * `userId` never crosses into an admin response.
 */
function findProvider(providerId: string, orgId: string) {
  return prisma.ssoProvider.findFirst({
    where: { providerId, organizationId: orgId },
    select: {
      id: true,
      providerId: true,
      issuer: true,
      domain: true,
      domainVerified: true,
      oidcConfig: true,
    },
  });
}

export async function DELETE(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; providerId: string }>;
  },
) {
  const { orgId, providerId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "identity.manage",
    requireActive: true,
  });
  if (access.error) return access.error;

  try {
    // The bell below names the domain owners recognize; the slug stays in
    // the audit row for forensics.
    let deletedDomain = providerId;
    await prisma.$transaction(async (tx) => {
      const current = await tx.ssoProvider.findFirst({
        where: { providerId, organizationId: orgId },
      });
      if (!current) {
        throw Object.assign(new Error("SSO provider not found"), {
          httpStatus: 404,
        });
      }
      deletedDomain = current.domain;

      // Enforcement fails open without an approved provider, so deleting the
      // last one would silently switch it off. Make the owner do that openly.
      if (current.domainVerified) {
        const settings = await tx.organizationSSOSettings.findUnique({
          where: { organizationId: orgId },
          select: { enforceSSO: true },
        });
        const remaining = settings?.enforceSSO
          ? await tx.ssoProvider.count({
              where: {
                organizationId: orgId,
                domainVerified: true,
                id: { not: current.id },
              },
            })
          : 1;
        if (remaining === 0) {
          throw Object.assign(
            new Error(
              "Cannot delete the last approved SSO provider while SSO is enforced. Disable enforcement first.",
            ),
            { httpStatus: 409 },
          );
        }
      }

      await tx.ssoProvider.delete({ where: { id: current.id } });

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SETTINGS",
          action: AUDIT_ACTIONS.SETTINGS.SSO_DISABLED,
          description: `SSO provider '${providerId}' removed`,
          details: {
            providerId,
            domain: current.domain,
            issuer: current.issuer,
          },
        },
      });
    });

    // Security alert: notify the org's OWNER roster via Novu. SSO
    // deletion is a high-impact action — if a malicious OWNER strips
    // SSO, every other OWNER sees it on their bell immediately.
    const origin = new URL(req.url).origin;
    notifyOrgSsoProviderDeleted(orgId, {
      orgName: access.org.name,
      providerId: deletedDomain,
      deletedByName: access.session.user.name ?? access.session.user.email,
      dashboardUrl: `${origin}/dashboard/organization/${orgId}/settings/sso`,
    }).catch((err) => {
      Sentry.captureException(
        err instanceof Error ? err : new Error(String(err)),
        { tags: { subsystem: "organizations" } },
      );
      console.error("[notifyOrgSsoProviderDeleted] failed:", err);
    });

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status = typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "organizations" } },
    );
    throw err;
  }
}
