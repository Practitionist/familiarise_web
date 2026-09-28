/**
 * GET    /api/organizations/[orgId]/sso/providers/[providerId]
 * DELETE /api/organizations/[orgId]/sso/providers/[providerId]
 *
 * Detail + delete for a single SSO provider registration. PATCH is NOT
 * offered — identity-provider config edits are risky (a silent typo in
 * `entryPoint` or `cert` locks users out), so the UX is delete-and-recreate.
 *
 * The URL path uses the human `providerId` slug, not the internal row
 * uuid, to match the IdP-side setup flow (admins copy the slug into their
 * IdP's metadata).
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { deriveAcsUrl, deriveMetadataUrl } from "@/lib/sso/derive-urls";
import { notifyOrgSsoProviderDeleted } from "@/lib/novu/org-workflows";
import { SecretPayloadError, type SecretPayloadFailure } from "@/lib/sso/secret-crypto";

/**
 * The message an OWNER sees when their provider's config cannot be read.
 *
 * Two cases, kept apart because they need opposite responses from the
 * operator. A missing key is ours to fix and re-entering the IdP details
 * will not help; anything else (wrong key, truncated column, non-JSON
 * garbage) is almost always a row the admin can repair themselves, and
 * telling them to contact support for a self-inflicted problem wastes a
 * round trip.
 *
 * Note what is no longer expressible: which of the two columns failed. The
 * decrypt happens inside a single `findFirst`, and `SecretPayloadError` does
 * not carry a column name, so a provider with both configs unreadable is
 * reported once rather than twice. That is a small loss of diagnostic
 * precision and it is not worth an extra query to recover — the resolution
 * is the same either way.
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
  // floor that admitted BILLING_ADMIN; secrets stay OWNER-only below.
  const access = await requireOrgAccess(orgId, { permission: "identity.read" });
  if (access.error) return access.error;

  // This query is where the stored config is decrypted: the
  // `$extends({ result })` map in `lib/prisma-sso-secret-extension.ts`
  // normalises `oidcConfig` / `samlConfig` to parsed objects on the way
  // out, for both the `sso:v1:` envelope and the legacy plaintext-JSON
  // format. So there is nothing to decode here, and no per-column
  // `try`/`catch` — a row we cannot read now fails as ONE query rather
  // than as one column, and that failure has to be caught here.
  //
  // Reported as 200 with `providerMisconfigured` set, not as an error status.
  // The settings page has to render *something* for this provider, and the
  // only thing it can honestly render is its identity with no config; a 4xx
  // or 5xx makes the client treat the response as a failed fetch and drop the
  // provider from the list entirely, which leaves the admin with no idea
  // which org-scoped IdP just went dark. (An earlier version of this comment
  // claimed 409; the code has always returned 200, and 200 is what the
  // settings page is written against.)
  let provider: Awaited<ReturnType<typeof findProvider>>;
  let configError: string | null = null;
  try {
    provider = await findProvider(providerId, orgId);
  } catch (err) {
    if (!(err instanceof SecretPayloadError)) throw err;
    Sentry.captureException(err, {
      tags: { subsystem: "enterprise", op: "sso-provider-read" },
      extra: { failure: err.failure },
    });
    configError = unreadableConfigError(err.failure);
    // The shape is fixed and the ids are route params, so a placeholder row
    // is enough to keep the response identical to the readable case. The
    // configs are `null` below, so a failed read can never leak a partial
    // config into the MAINTAINER branch either.
    provider = {
      id: "",
      providerId,
      issuer: "",
      domain: "",
      samlConfig: null,
      oidcConfig: null,
    };
  }

  if (!provider) {
    return NextResponse.json(
      { error: "SSO provider not found" },
      { status: 404 },
    );
  }

  // Only identity.manage (OWNER) gets the full config JSON in the payload.
  // Everyone else sees redacted markers — cert/client-secret values would
  // leak sensitive IdP credentials otherwise.
  const isOwner = hasOrgPermission(access.member.role, "identity.manage");
  const type: "saml" | "oidc" | null = provider.samlConfig
    ? "saml"
    : provider.oidcConfig
      ? "oidc"
      : null;

  // A provider row with neither config is a half-written record (e.g.
  // an admin started a SAML setup, dropped the cert, never finished).
  // Fabricating an `acsUrl` from a null type would write a misleading
  // value into the admin UI; return null instead so the page can
  // render the "configuration incomplete" state correctly.
  const acsUrl = type ? deriveAcsUrl(provider.providerId, type) : null;

  if (!isOwner) {
    return NextResponse.json({
      provider: {
        id: provider.id,
        providerId: provider.providerId,
        issuer: provider.issuer,
        domain: provider.domain,
        providerType: type,
        acsUrl,
        metadataUrl: deriveMetadataUrl(provider.providerId),
        // A MAINTAINER's rank stops at `identity.read`; the client secret
        // and the SAML cert stay with OWNER. Reported as present, not shown.
        oidcConfig: provider.oidcConfig ? "[redacted]" : null,
        samlConfig: provider.samlConfig ? "[redacted]" : null,
      },
    });
  }

  return NextResponse.json({
    provider: {
      id: provider.id,
      providerId: provider.providerId,
      issuer: provider.issuer,
      domain: provider.domain,
      providerType: type,
      acsUrl,
      metadataUrl: deriveMetadataUrl(provider.providerId),
      // The parsed config objects, verbatim. The settings form pre-fills
      // from these and `clientSecret` and the PEM `cert` are in here in
      // cleartext — that is the existing contract for `identity.manage`,
      // unchanged by this route.
      //
      // They are passed through rather than validated or rebuilt on
      // purpose. This view exists so an admin can SEE the config that is
      // actually stored, including the field that is wrong; a
      // reconstruct-from-schema response would show them a well-formed
      // config that differs from the real one, which is the opposite of
      // useful when they are mid-repair. (The `test` endpoint is the
      // validating view — it checks one field at a time and says which one
      // is wrong.)
      oidcConfig: provider.oidcConfig,
      samlConfig: provider.samlConfig,
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
 * The provider row, as the Prisma layer returns it: the two config columns
 * already decrypted and parsed.
 *
 * `select` is explicit so the returned shape is exactly what this route
 * serves — `userId` in particular has no business crossing into an admin
 * response — and so the placeholder the unreadable path substitutes is
 * checked against the same shape as a real row.
 */
function findProvider(providerId: string, orgId: string) {
  return prisma.ssoProvider.findFirst({
    where: { providerId, organizationId: orgId },
    select: {
      id: true,
      providerId: true,
      issuer: true,
      domain: true,
      oidcConfig: true,
      samlConfig: true,
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
  });
  if (access.error) return access.error;

  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.ssoProvider.findFirst({
        where: { providerId, organizationId: orgId },
      });
      if (!current) {
        throw Object.assign(new Error("SSO provider not found"), {
          httpStatus: 404,
        });
      }

      // Refuse if removing the last provider would leave the org in an
      // inconsistent state — enforceSSO=true with zero providers and no
      // allowed domains would lock every user out. Admins must drop
      // enforcement or add a domain first.
      const settings = await tx.organizationSSOSettings.findUnique({
        where: { organizationId: orgId },
      });
      if (settings?.enforceSSO) {
        const remaining = await tx.ssoProvider.count({
          where: { organizationId: orgId, id: { not: current.id } },
        });
        const effectiveDomains = settings.allowedEmailDomains ?? [];
        if (remaining === 0 && effectiveDomains.length === 0) {
          throw Object.assign(
            new Error(
              "Cannot delete the last SSO provider while enforceSSO=true and no allowed domains. Disable enforcement or add a domain first.",
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
      providerId,
      deletedByName:
        access.session.user.name ?? access.session.user.email,
      dashboardUrl: `${origin}/dashboard/organization/${orgId}/settings/sso`,
    }).catch((err) => {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "organizations" } });
      console.error("[notifyOrgSsoProviderDeleted] failed:", err);
    });

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "organizations" } });
    throw err;
  }
}
