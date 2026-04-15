/**
 * Organizations API — top-level collection.
 *
 * GET  — list the caller's orgs (ADMIN sees all)
 * POST — create a new organization + profile + owner membership atomically
 *
 * PROVIDER orgs are gated by the ENABLE_PROVIDER_ORGS feature flag. When the
 * flag is off, a POST with `kind === "PROVIDER"` (or `HYBRID`) is rejected
 * with 501. See lib/feature-flags.ts and Issue #646.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { ENABLE_PROVIDER_ORGS } from "@/lib/feature-flags";
import {
  OrganizationKind,
  OrganizationBillingMode,
  OrgSizeBucket,
} from "@prisma/client";

const createOrgSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens")
    .min(2)
    .max(50)
    .optional(),
  kind: z.nativeEnum(OrganizationKind).default(OrganizationKind.BUYER),
  // billingMode is required for BUYER/HYBRID, ignored/nulled for PROVIDER.
  // Validated at handler level based on `kind` — see logic below.
  billingMode: z.nativeEnum(OrganizationBillingMode).optional(),
  billingEmail: z.string().email(),
  description: z.string().max(2000).optional(),
  industry: z.string().max(100).optional(),
  sizeBucket: z.nativeEnum(OrgSizeBucket).optional(),
  website: z.string().url().optional(),
  logo: z.string().url().optional(),
});

/**
 * Slugify a name into a URL-safe string. Collisions resolved at insert time
 * by appending a short random suffix on unique-constraint failure.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * GET /api/organizations
 * Lists the caller's active org memberships. Platform ADMINs see every org.
 */
export async function GET() {
  try {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;

    const userId = auth.session.user.id;

    if (auth.session.user.role === "ADMIN") {
      const orgs = await prisma.organizationProfile.findMany({
        include: {
          organization: {
            select: { id: true, name: true, slug: true, logo: true },
          },
        },
        orderBy: { createdAt: "desc" },
      });
      return NextResponse.json({
        organizations: orgs.map((o) => ({
          id: o.organization.id,
          profileId: o.id,
          name: o.organization.name,
          slug: o.organization.slug,
          logo: o.organization.logo,
          kind: o.kind,
          status: o.status,
          billingMode: o.billingMode,
          role: "ORG_OWNER" as const,
          isPlatformAdmin: true,
        })),
      });
    }

    const memberships = await prisma.organizationMemberProfile.findMany({
      where: {
        status: "ACTIVE",
        member: { userId },
      },
      include: {
        organizationProfile: {
          include: {
            organization: {
              select: { id: true, name: true, slug: true, logo: true },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({
      organizations: memberships
        .filter((m) => m.organizationProfile.status !== "DEACTIVATED")
        .map((m) => ({
          id: m.organizationProfile.organization.id,
          profileId: m.organizationProfileId,
          name: m.organizationProfile.organization.name,
          slug: m.organizationProfile.organization.slug,
          logo: m.organizationProfile.organization.logo,
          kind: m.organizationProfile.kind,
          status: m.organizationProfile.status,
          billingMode: m.organizationProfile.billingMode,
          role: m.role,
          isPlatformAdmin: false,
        })),
    });
  } catch (error) {
    console.error("[API /organizations GET] error:", error);
    return NextResponse.json(
      { error: "Failed to fetch organizations" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/organizations
 * Creates a new organization with the caller as ORG_OWNER. All four rows
 * (Organization, OrganizationProfile, Member, OrganizationMemberProfile) are
 * inserted in a single transaction. PROVIDER and HYBRID kinds are rejected
 * with 501 unless ENABLE_PROVIDER_ORGS is set.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;

    const body = await req.json();
    const parsed = createOrgSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const {
      name,
      slug: slugInput,
      kind,
      billingMode,
      billingEmail,
      description,
      industry,
      sizeBucket,
      website,
      logo,
    } = parsed.data;

    // Feature-flag gate for PROVIDER-adjacent kinds.
    if (
      !ENABLE_PROVIDER_ORGS &&
      (kind === "PROVIDER" || kind === "HYBRID")
    ) {
      return NextResponse.json(
        {
          error:
            "PROVIDER organizations are not yet available. Contact support if you represent a consultant agency.",
          flag: "ENABLE_PROVIDER_ORGS",
        },
        { status: 501 },
      );
    }

    // Billing mode semantics by org kind:
    //   BUYER / HYBRID → billingMode is required (defaults to TAG_ONLY if unspecified)
    //   PROVIDER        → billingMode is null (PROVIDER orgs earn money, they don't pay)
    const resolvedBillingMode: OrganizationBillingMode | null =
      kind === "PROVIDER"
        ? null
        : (billingMode ?? OrganizationBillingMode.TAG_ONLY);

    // Enforce the 5-org creation limit to mirror BetterAuth's organizationLimit.
    const ownedCount = await prisma.member.count({
      where: {
        userId: auth.session.user.id,
        role: "ORG_OWNER",
      },
    });
    if (ownedCount >= 5) {
      return NextResponse.json(
        { error: "You have reached the maximum number of owned organizations (5)." },
        { status: 403 },
      );
    }

    // Generate slug from name if not supplied; retry once with a random
    // suffix if the initial insert collides on the unique constraint.
    const baseSlug = slugInput ?? slugify(name);
    if (!baseSlug) {
      return NextResponse.json(
        { error: "Could not derive a valid slug from the organization name" },
        { status: 400 },
      );
    }

    const runTransaction = (slug: string) =>
      prisma.$transaction(async (tx) => {
        const organization = await tx.organization.create({
          data: { name, slug, logo: logo ?? null },
        });

        const profile = await tx.organizationProfile.create({
          data: {
            organizationId: organization.id,
            kind,
            billingMode: resolvedBillingMode,
            billingEmail,
            description: description ?? null,
            industry: industry ?? null,
            sizeBucket: sizeBucket ?? null,
            website: website ?? null,
            logo: logo ?? null,
            // PROVIDER/HYBRID orgs require admin approval before activation
            status:
              kind === "PROVIDER" || kind === "HYBRID"
                ? "PENDING_VERIFICATION"
                : "ACTIVE",
          },
        });

        const member = await tx.member.create({
          data: {
            organizationId: organization.id,
            userId: auth.session.user.id,
            role: "ORG_OWNER",
          },
        });

        await tx.organizationMemberProfile.create({
          data: {
            memberId: member.id,
            organizationProfileId: profile.id,
            role: "ORG_OWNER",
            status: "ACTIVE",
          },
        });

        // SEAT_PACK orgs get a zeroed credit pool created up front so the
        // dashboard can render without a null check.
        if (resolvedBillingMode === "SEAT_PACK") {
          await tx.orgCreditPool.create({
            data: {
              organizationProfileId: profile.id,
              balance: 0,
              totalPurchased: 0,
            },
          });
        }

        return { organization, profile };
      });

    let result: Awaited<ReturnType<typeof runTransaction>>;
    try {
      result = await runTransaction(baseSlug);
    } catch (error) {
      // P2002 = unique constraint violation (most likely: slug collision)
      const code = (error as { code?: string })?.code;
      if (code === "P2002") {
        const fallbackSlug = `${baseSlug}-${Math.random().toString(36).slice(2, 8)}`;
        result = await runTransaction(fallbackSlug);
      } else {
        throw error;
      }
    }

    return NextResponse.json(
      {
        organization: {
          id: result.organization.id,
          name: result.organization.name,
          slug: result.organization.slug,
          logo: result.organization.logo,
        },
        profile: {
          id: result.profile.id,
          kind: result.profile.kind,
          status: result.profile.status,
          billingMode: result.profile.billingMode,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[API /organizations POST] error:", error);
    return NextResponse.json(
      { error: "Failed to create organization" },
      { status: 500 },
    );
  }
}
