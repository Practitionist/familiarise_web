/**
 * GET  /api/organizations
 * POST /api/organizations
 *
 * GET returns the orgs the caller is a member of — the list behind the
 * "your organizations" switcher in the UI. Each entry carries the light
 * fields the switcher needs (capability booleans, fundingSource, role).
 *
 * POST creates a new Organization + BillingAccount + OWNER Membership in
 * a single transaction. The caller is the OWNER of the created org; a
 * matching BetterAuth `Member` row is also written (so the org-scope
 * session gets populated on the next login).
 *
 * Invariants:
 *  - slug is unique and lower-cased;
 *  - at least one capability must be true (canSponsor OR canHost);
 *  - canSponsor=true → BillingAccount created with the chosen fundingSource;
 *  - rootId points at the org itself (hierarchy is schema-only in v1).
 */

import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

// PROJECT is reserved in the Prisma enum for the v2 milestone workflow
// (scoped project-billing engine), but not accepted at the API boundary
// yet — callers that pick it would otherwise silently fall into the
// TAG_ONLY path in checkout. Re-add here once checkout has a dedicated
// PROJECT branch.
const FundingSourceSchema = z.enum([
  "PERSONAL",
  "LICENSE",
  "WALLET",
  "INVOICE",
]);
const CurrencySchema = z.enum(["INR", "USD", "EUR", "GBP"]);
const DataRegionSchema = z.enum(["IN", "US", "EU"]);
const SizeBucketSchema = z.enum([
  "SMALL_1_50",
  "MEDIUM_51_200",
  "LARGE_201_1000",
  "ENTERPRISE_1000_PLUS",
]);

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const CreateBodySchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(63)
      .regex(SLUG_REGEX, "slug must be lower-case alphanumeric with hyphens")
      .optional(),
    canSponsor: z.boolean().default(true),
    canHost: z.boolean().default(false),
    fundingSource: FundingSourceSchema.default("PERSONAL"),
    billingEmail: z.string().email(),
    currency: CurrencySchema.default("INR"),
    paymentTermsDays: z.coerce.number().int().min(0).max(180).optional(),
    description: z.string().max(5000).nullable().optional(),
    industry: z.string().max(120).nullable().optional(),
    website: z.string().url().nullable().optional(),
    sizeBucket: SizeBucketSchema.nullable().optional(),
    dataResidencyRegion: DataRegionSchema.default("IN"),
    gstin: z.string().length(15).nullable().optional(),
    pan: z.string().length(10).nullable().optional(),
    requiresPO: z.boolean().default(false),
  })
  .refine((v) => v.canSponsor || v.canHost, {
    message: "At least one of canSponsor or canHost must be true",
  });

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export async function GET() {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;

  const userId = auth.session.user.id;
  const memberships = await prisma.membership.findMany({
    where: { userId, status: "ACTIVE" },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
          logo: true,
          status: true,
          canSponsor: true,
          canHost: true,
          billingAccount: {
            select: { fundingSource: true, walletBalance: true, currency: true },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({
    data: memberships.map((m) => ({
      membershipId: m.id,
      role: m.role,
      status: m.status,
      organization: m.organization,
    })),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;

  const raw = await req.json().catch(() => null);
  const parsed = CreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const desiredSlug = body.slug ?? slugify(body.name);
  if (!SLUG_REGEX.test(desiredSlug)) {
    return NextResponse.json(
      { error: "Generated slug is invalid — pass `slug` explicitly." },
      { status: 400 },
    );
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const dupSlug = await tx.organization.findUnique({
        where: { slug: desiredSlug },
        select: { id: true },
      });
      if (dupSlug) {
        throw Object.assign(
          new Error(`Slug '${desiredSlug}' is already taken`),
          { httpStatus: 409 },
        );
      }

      // Create the org first WITHOUT billingAccountId so we can then
      // create the BillingAccount (it needs ownerOrgId). Then patch
      // back the link.
      const orgTmpId = randomUUID();
      const org = await tx.organization.create({
        data: {
          id: orgTmpId,
          name: body.name,
          slug: desiredSlug,
          canSponsor: body.canSponsor,
          canHost: body.canHost,
          rootId: orgTmpId,
          depth: 0,
          dataResidencyRegion: body.dataResidencyRegion,
          contractCurrency: body.currency,
          reportingCurrency: body.currency,
          billingEmail: body.billingEmail,
          paymentTermsDays: body.paymentTermsDays ?? 60,
          description: body.description ?? null,
          industry: body.industry ?? null,
          website: body.website ?? null,
          sizeBucket: body.sizeBucket ?? null,
          gstin: body.gstin ?? null,
          pan: body.pan ?? null,
          requiresPO: body.requiresPO,
          status: "PENDING_VERIFICATION",
        },
      });

      let billingAccountId: string | null = null;
      if (body.canSponsor) {
        const ba = await tx.billingAccount.create({
          data: {
            ownerOrgId: org.id,
            billingEmail: body.billingEmail,
            currency: body.currency,
            fundingSource: body.fundingSource,
            walletBalance: body.fundingSource === "WALLET" ? 0 : null,
          },
        });
        billingAccountId = ba.id;
        await tx.organization.update({
          where: { id: org.id },
          data: { billingAccountId: ba.id },
        });
      }

      // OWNER Membership + a matching BetterAuth Member for invitation
      // + org-scope session support. The Member row's id becomes the
      // betterAuthMemberId pointer on Membership so the bridge is live
      // from the moment the org exists.
      const betterAuthMember = await tx.member.create({
        data: {
          organizationId: org.id,
          userId: auth.session.user.id,
          role: "OWNER",
        },
      });
      const membership = await tx.membership.create({
        data: {
          userId: auth.session.user.id,
          organizationId: org.id,
          status: "ACTIVE",
          role: "OWNER",
          betterAuthMemberId: betterAuthMember.id,
        },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: org.id,
          actorMembershipId: membership.id,
          targetMembershipId: membership.id,
          category: "MEMBER",
          action: AUDIT_ACTIONS.MEMBER.MEMBER_ADDED,
          description: `Organization '${org.name}' created by OWNER`,
          details: {
            slug: org.slug,
            canSponsor: org.canSponsor,
            canHost: org.canHost,
            fundingSource: body.canSponsor ? body.fundingSource : null,
          },
        },
      });

      return {
        organization: org,
        billingAccountId,
        membership,
      };
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
