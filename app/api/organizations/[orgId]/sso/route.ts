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

const patchSsoSchema = z.object({
  allowedEmailDomains: z.array(z.string().min(3).max(255)).optional(),
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

    const providers = await prisma.ssoProvider.findMany({
      where: { organizationId: orgId },
      select: {
        id: true,
        providerId: true,
        issuer: true,
        domain: true,
        userId: true,
      },
    });

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

    const settings = await prisma.organizationSSOSettings.upsert({
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

    return NextResponse.json({ settings });
  } catch (error) {
    console.error("[API /organizations/[orgId]/sso PATCH] error:", error);
    return NextResponse.json(
      { error: "Failed to update SSO settings" },
      { status: 500 },
    );
  }
}
