/**
 * GET    /api/organizations/[orgId]/catalog
 * POST   /api/organizations/[orgId]/catalog
 * DELETE /api/organizations/[orgId]/catalog
 *
 * The org's OWN bookable offerings — the plans it authors and owns, as opposed
 * to `/programs`, which is the sponsor-side entitlement that funds bookings of
 * somebody else's plans.
 *
 * #778 collapsed the standalone `OrganizationPlan` table into the per-type
 * plans, so "an org's catalog" is exactly its `WebinarPlan` / `ClassPlan` rows
 * with `organizationId` set. Consultation and Subscription are deliberately
 * absent: both require a `consultantProfileId` in the schema and so can never
 * be solely org-owned. See docs/enterprise/30-programs-and-lifecycle/05-public-pages-and-discovery.md.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const PlanKindSchema = z.enum(["WEBINAR", "CLASS"]);

const VisibilitySchema = z.enum(["PUBLIC", "ORG_ONLY", "ORG_AND_PUBLIC"]);

const RemoveBodySchema = z.object({
  kind: PlanKindSchema,
  planIds: z.array(z.string().min(1)).min(1).max(100),
});

const BaseCreateSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1),
  // Paise. ADR 02 — money is integer paise end to end; the column is BigInt.
  pricePaise: z.number().int().min(0),
  // The EXPERT who delivers. Nullable in the schema, but an org plan nobody
  // can deliver is not bookable, so the endpoint requires it.
  consultantProfileId: z.string().min(1),
  visibility: VisibilitySchema.default("ORG_AND_PUBLIC"),
  maxParticipants: z.number().int().positive().optional(),
  language: z.string().default("English"),
  level: z.string().default("Beginner"),
  certificateProvided: z.boolean().default(false),
  recordingEnabled: z.boolean().default(false),
});

// The two types diverge on their duration grid, which is why this is a
// discriminated union rather than one schema with optional extras: a webinar is
// a single sitting of N hours, a class is a recurring course.
const CreateBodySchema = z.discriminatedUnion("kind", [
  BaseCreateSchema.extend({
    kind: z.literal("WEBINAR"),
    durationInHours: z.number().positive().default(1),
  }),
  BaseCreateSchema.extend({
    kind: z.literal("CLASS"),
    durationInMonths: z.number().int().positive().default(1),
    meetingsPerWeek: z.number().int().positive().default(1),
    sessionDurationInHours: z.number().positive().default(1),
  }),
]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "catalog.manage",
    canHost: true,
  });
  if (access.error) return access.error;

  const [webinars, classes] = await Promise.all([
    prisma.webinarPlan.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: "desc" },
      include: { consultantProfile: { select: { id: true, userId: true } } },
    }),
    prisma.classPlan.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: "desc" },
      include: { consultantProfile: { select: { id: true, userId: true } } },
    }),
  ]);

  // BigInt is not JSON-serializable — paise cross the wire as strings, matching
  // the money convention the rest of the org surfaces use.
  return NextResponse.json({
    webinars: webinars.map((w) => ({ ...w, price: w.price.toString() })),
    classes: classes.map((c) => ({ ...c, price: c.price.toString() })),
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "catalog.manage",
    canHost: true,
    // Publishing an offering is a commercial act; an unverified org must not
    // put bookable inventory on the marketplace.
    requireActive: true,
  });
  if (access.error) return access.error;

  const parsed = CreateBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // The named deliverer must be an ACTIVE EXPERT of THIS org. Without this an
  // operator could point an org plan at any consultantProfileId on the
  // platform and commit a stranger to delivering it.
  const expert = await prisma.membership.findFirst({
    where: {
      organizationId: orgId,
      status: "ACTIVE",
      role: "EXPERT",
      consultantProfileId: body.consultantProfileId,
    },
    select: { id: true },
  });
  if (!expert) {
    return NextResponse.json(
      {
        error: "NOT_AN_ORG_EXPERT",
        message:
          "The selected consultant is not an active EXPERT in this organization.",
      },
      { status: 422 },
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    const common = {
      title: body.title,
      description: body.description,
      price: BigInt(body.pricePaise),
      priceCurrency: "INR" as const,
      consultantProfileId: body.consultantProfileId,
      organizationId: orgId,
      visibility: body.visibility,
      language: body.language,
      level: body.level,
      certificateProvided: body.certificateProvided,
      recordingEnabled: body.recordingEnabled,
    };

    const plan =
      body.kind === "WEBINAR"
        ? await tx.webinarPlan.create({
            data: {
              ...common,
              durationInHours: body.durationInHours,
              maxParticipants: body.maxParticipants ?? 100,
            },
          })
        : await tx.classPlan.create({
            data: {
              ...common,
              durationInMonths: body.durationInMonths,
              meetingsPerWeek: body.meetingsPerWeek,
              sessionDurationInHours: body.sessionDurationInHours,
              // Kept consistent with the schema's own derivation note
              // (meetingsPerWeek × durationInMonths × 4) so the stored
              // totals never disagree with the grid that produced them.
              totalSessions: body.meetingsPerWeek * body.durationInMonths * 4,
              totalHours:
                body.meetingsPerWeek *
                body.durationInMonths *
                4 *
                body.sessionDurationInHours,
              maxParticipants: body.maxParticipants ?? 30,
            },
          });

    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "CATALOG",
        action: AUDIT_ACTIONS.CATALOG.CATALOG_PLAN_CREATED,
        description: `${body.kind === "WEBINAR" ? "Webinar" : "Class"} plan "${plan.title}" added to the catalog`,
        details: {
          planId: plan.id,
          kind: body.kind,
          visibility: body.visibility,
          consultantProfileId: body.consultantProfileId,
        },
      },
    });

    return plan;
  });

  return NextResponse.json(
    { plan: { ...created, price: created.price.toString() } },
    { status: 201 },
  );
}

/**
 * Remove plans from the catalog.
 *
 * NOTE: neither `WebinarPlan` nor `ClassPlan` has an `isActive` / `archivedAt`
 * column — the `AUDIT_ACTIONS.CATALOG` docstrings still describe the retired
 * `OrganizationPlan`, which did. So "deactivate" is not representable today and
 * this endpoint deletes instead, refusing once anything has been scheduled off
 * the plan. Soft-archiving a plan that already has bookings needs a schema
 * field, which belongs in the pre-launch freeze rather than here.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "catalog.manage",
    canHost: true,
  });
  if (access.error) return access.error;

  const parsed = RemoveBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { kind, planIds } = parsed.data;

  const removed = await prisma.$transaction(async (tx) => {
    // Scoped by organizationId as well as id, so a stolen id from another
    // tenant matches nothing rather than deleting their row.
    const scope = { id: { in: planIds }, organizationId: orgId };

    const scheduled =
      kind === "WEBINAR"
        ? await tx.webinar.count({ where: { webinarPlanId: { in: planIds } } })
        : await tx.class.count({ where: { classPlanId: { in: planIds } } });

    if (scheduled > 0) {
      return { blocked: true as const, count: 0 };
    }

    const { count } =
      kind === "WEBINAR"
        ? await tx.webinarPlan.deleteMany({ where: scope })
        : await tx.classPlan.deleteMany({ where: scope });

    if (count > 0) {
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "CATALOG",
          action: AUDIT_ACTIONS.CATALOG.CATALOG_PLAN_DEACTIVATED,
          description: `${count} ${kind === "WEBINAR" ? "webinar" : "class"} plan(s) removed from the catalog`,
          details: { kind, planIds },
        },
      });
    }

    return { blocked: false as const, count };
  });

  if (removed.blocked) {
    return NextResponse.json(
      {
        error: "PLAN_HAS_SESSIONS",
        message:
          "This plan already has scheduled sessions and cannot be removed. Sessions must be cancelled first.",
      },
      { status: 409 },
    );
  }

  return NextResponse.json({ removed: removed.count });
}
