/**
 * Org SSO settings — GET / PATCH.
 *
 * GET   — ORG_OWNER. Returns OrganizationSSOSettings + the list of providers
 *         registered through BetterAuth's SSO plugin for this org.
 * PATCH — ORG_OWNER. Updates allowedEmailDomains, enforceSSO, and
 *         defaultRoleForAutoJoin. Provider CRUD is in /sso/providers.
 *
 * The BetterAuth `ssoProvider` table is queried via Prisma directly. The
 * plugin doesn't expose typed list/delete helpers — providers are linked to
 * an org via the `organizationId` column the plugin auto-adds.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { OrgMemberRole } from "@prisma/client";

// RFC-1123 hostname regex: labels separated by dots, no leading/trailing hyphens.
const DOMAIN_REGEX = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

const patchSsoSchema = z.object({
  allowedEmailDomains: z
    .array(
      z
        .string()
        .min(3)
        .max(255)
        .regex(DOMAIN_REGEX, "Must be a valid domain (e.g. example.com)"),
    )
    .optional(),
  enforceSSO: z.boolean().optional(),
  defaultRoleForAutoJoin: z.nativeEnum(OrgMemberRole).optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_OWNER");
    if (access.error) return access.error;

    const settings = await prisma.organizationSSOSettings.findUnique({
      where: { organizationProfileId: access.org.id },
    });

    const rows = await prisma.ssoProvider.findMany({
      where: { organizationId: orgId },
      select: {
        id: true,
        providerId: true,
        issuer: true,
        domain: true,
        samlConfig: true,
        oidcConfig: true,
      },
    });

    // Surface providerType so the UI can render the correct ACS / redirect URL.
    const providers = rows.map((r) => ({
      id: r.id,
      providerId: r.providerId,
      issuer: r.issuer,
      domain: r.domain,
      providerType: r.samlConfig ? "saml" : r.oidcConfig ? "oidc" : null,
    }));

    return NextResponse.json({
      settings: settings ?? {
        allowedEmailDomains: [],
        enforceSSO: false,
        defaultRoleForAutoJoin: "ORG_LEARNER" as const,
      },
      providers,
    });
  } catch (error) {
    console.error("[API /organizations/[orgId]/sso GET] error:", error);
    return NextResponse.json(
      { error: "Failed to fetch SSO settings" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_OWNER");
    if (access.error) return access.error;

    const body = await req.json();
    const parsed = patchSsoSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    // Domain-claim sync + settings upsert run in a single transaction so the
    // cross-org uniqueness check is atomic. The OrgDomainClaim table has a
    // @unique on `domain`, so concurrent PATCH requests from two orgs claiming
    // the same domain will race at createMany: the loser gets P2002 → 409.
    // This eliminates the TOCTOU gap in the old findMany → check → upsert flow.
    let settings;
    try {
      settings = await prisma.$transaction(async (tx) => {
        if (parsed.data.allowedEmailDomains !== undefined) {
          // Delete this org's existing claims, then re-insert the new set.
          // If another org already holds a domain in the new set, createMany
          // throws P2002 (unique constraint on OrgDomainClaim.domain) and the
          // whole transaction rolls back.
          await tx.orgDomainClaim.deleteMany({
            where: { organizationProfileId: access.org.id },
          });
          if (parsed.data.allowedEmailDomains.length > 0) {
            await tx.orgDomainClaim.createMany({
              data: parsed.data.allowedEmailDomains.map((domain) => ({
                organizationProfileId: access.org.id,
                domain,
              })),
            });
          }
        }

        return tx.organizationSSOSettings.upsert({
          where: { organizationProfileId: access.org.id },
          create: {
            organizationProfileId: access.org.id,
            allowedEmailDomains: parsed.data.allowedEmailDomains ?? [],
            enforceSSO: parsed.data.enforceSSO ?? false,
            defaultRoleForAutoJoin:
              parsed.data.defaultRoleForAutoJoin ?? "ORG_LEARNER",
          },
          update: parsed.data,
        });
      });
    } catch (txError) {
      if ((txError as { code?: string })?.code === "P2002") {
        return NextResponse.json(
          {
            error:
              "One or more of the specified domains are already claimed by another organization.",
          },
          { status: 409 },
        );
      }
      throw txError;
    }

    return NextResponse.json({ settings });
  } catch (error) {
    console.error("[API /organizations/[orgId]/sso PATCH] error:", error);
    return NextResponse.json(
      { error: "Failed to update SSO settings" },
      { status: 500 },
    );
  }
}
