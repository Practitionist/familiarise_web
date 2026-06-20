/**
 * GET   /api/organizations/[orgId]/sso
 * PATCH /api/organizations/[orgId]/sso
 *
 * Org-level SSO settings (separate from the individual IdP configs under
 * /sso/providers). This endpoint governs:
 *   - allowedEmailDomains      — which domains qualify for auto-join
 *   - enforceSSO               — require SSO for all sign-ins
 *   - defaultRoleForAutoJoin   — role newly auto-joined users receive
 *
 * Settings are upserted on PATCH — the record exists 1:1 with Organization,
 * and missing == defaults (empty domains / no enforcement / LEARNER default).
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess, requireOrgOwner } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { DomainSchema } from "@/lib/enterprise/validators";
import { JitDefaultRoleSchema } from "@/lib/labels/org-labels";
import {
  DomainVerificationRequiredError,
  hasVerifiedDomain,
} from "@/lib/enterprise/governance";

const PatchBodySchema = z
  .object({
    allowedEmailDomains: z.array(DomainSchema).max(50).optional(),
    enforceSSO: z.boolean().optional(),
    // JIT auto-join is locked to LEARNER. Admins promote new members
    // explicitly after first signin via /dashboard/.../members. This
    // closes a privilege-escalation hole where `defaultRoleForAutoJoin
    // = "OWNER"` would make the first SSO user co-owner. See audit
    // Phase A.1 + docs/enterprise/20-iam-and-security/01-sso-and-authentication.md.
    defaultRoleForAutoJoin: JitDefaultRoleSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "PATCH body must contain at least one field",
  });

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  const [settings, providers, claims] = await Promise.all([
    prisma.organizationSSOSettings.findUnique({
      where: { organizationId: orgId },
    }),
    prisma.ssoProvider.findMany({
      where: { organizationId: orgId },
      select: {
        id: true,
        providerId: true,
        issuer: true,
        domain: true,
        samlConfig: true,
        oidcConfig: true,
      },
    }),
    prisma.orgDomainClaim.findMany({
      where: { organizationId: orgId },
      select: { id: true, domain: true, claimedAt: true },
    }),
  ]);

  return NextResponse.json({
    settings: settings ?? {
      organizationId: orgId,
      allowedEmailDomains: [],
      enforceSSO: false,
      defaultRoleForAutoJoin: "LEARNER",
    },
    providers: providers.map(({ samlConfig, oidcConfig, ...rest }) => ({
      ...rest,
      providerType: samlConfig ? "saml" : oidcConfig ? "oidc" : null,
    })),
    domainClaims: claims,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = PatchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.organizationSSOSettings.findUnique({
        where: { organizationId: orgId },
      });

      // Enforcing SSO without at least one allowed domain OR an SSO
      // provider would lock every user out of the org. Catch it here.
      if (body.enforceSSO === true) {
        const effectiveDomains =
          body.allowedEmailDomains ??
          existing?.allowedEmailDomains ??
          [];
        const providerCount = await tx.ssoProvider.count({
          where: { organizationId: orgId },
        });
        if (effectiveDomains.length === 0 && providerCount === 0) {
          throw Object.assign(
            new Error(
              "Cannot enforce SSO without at least one allowed domain or SSO provider configured.",
            ),
            { httpStatus: 409 },
          );
        }
      }

      // PR-1d / #675: SSO settings (the high-impact ones — enforcement
      // + auto-join) require a verified domain. Without this gate any
      // org could enforce SSO against an unverified domain and lock
      // out members of a third-party org that happens to share the
      // email suffix.
      const sensitiveChange =
        body.enforceSSO === true ||
        (body.allowedEmailDomains !== undefined &&
          body.allowedEmailDomains.length > 0);
      if (sensitiveChange && !(await hasVerifiedDomain(tx, orgId))) {
        throw new DomainVerificationRequiredError("SSO");
      }

      const next = await tx.organizationSSOSettings.upsert({
        where: { organizationId: orgId },
        create: {
          organizationId: orgId,
          allowedEmailDomains: body.allowedEmailDomains ?? [],
          enforceSSO: body.enforceSSO ?? false,
          defaultRoleForAutoJoin: body.defaultRoleForAutoJoin ?? "LEARNER",
        },
        update: {
          ...(body.allowedEmailDomains !== undefined && {
            allowedEmailDomains: body.allowedEmailDomains,
          }),
          ...(body.enforceSSO !== undefined && {
            enforceSSO: body.enforceSSO,
          }),
          ...(body.defaultRoleForAutoJoin !== undefined && {
            defaultRoleForAutoJoin: body.defaultRoleForAutoJoin,
          }),
        },
      });

      // SSO_ENABLED/DISABLED specifically fires on enforceSSO flips,
      // not generic setting edits. Domain list changes still count as
      // SETTINGS_CHANGED.
      const ssoStateChanged =
        body.enforceSSO !== undefined &&
        body.enforceSSO !== (existing?.enforceSSO ?? false);
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SETTINGS",
          action: ssoStateChanged
            ? body.enforceSSO
              ? AUDIT_ACTIONS.SETTINGS.SSO_ENABLED
              : AUDIT_ACTIONS.SETTINGS.SSO_DISABLED
            : AUDIT_ACTIONS.SETTINGS.SETTINGS_CHANGED,
          description: "SSO settings updated",
          details: {
            from: {
              allowedEmailDomains: existing?.allowedEmailDomains ?? [],
              enforceSSO: existing?.enforceSSO ?? false,
              defaultRoleForAutoJoin:
                existing?.defaultRoleForAutoJoin ?? "LEARNER",
            },
            to: {
              allowedEmailDomains: next.allowedEmailDomains,
              enforceSSO: next.enforceSSO,
              defaultRoleForAutoJoin: next.defaultRoleForAutoJoin,
            },
          },
        },
      });

      return next;
    });

    return NextResponse.json({ settings: updated });
  } catch (err) {
    if (err instanceof DomainVerificationRequiredError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.httpStatus },
      );
    }
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
    throw err;
  }
}
