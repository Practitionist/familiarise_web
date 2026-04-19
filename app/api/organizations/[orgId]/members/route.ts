/**
 * GET    /api/organizations/[orgId]/members
 * POST   /api/organizations/[orgId]/members
 *
 * The single members endpoint subsumes the old /consultants and /learners
 * views — callers pass `?role=EXPERT` or `?role=LEARNER` to filter. Also
 * accepts a comma-separated role list (`?role=EXPERT,LEARNER`) for the
 * union case, plus `status` / `departmentLabel` / `q` / pagination.
 *
 * Everything is parsed through Zod. Runtime narrowing never relies on
 * `as` assertions.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import type { MemberRole, MemberStatus } from "@prisma/client";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { isBlockedRoleTransition } from "@/lib/enterprise/role-transitions";

// Canonical MemberRole Zod enum. Mirrors the Prisma enum — if a role
// is added to the schema, TS fails here until the list is updated.
const MemberRoleSchema = z.enum([
  "OWNER",
  "MAINTAINER",
  "MANAGER",
  "EXPERT",
  "LEARNER",
  "SUPPORT",
]);

const MemberStatusSchema = z.enum(["PENDING", "ACTIVE", "SUSPENDED", "REMOVED"]);

/**
 * Accepts a string like "EXPERT" or "EXPERT,LEARNER" and returns the
 * narrowed list. Empty/invalid → undefined (no filter applied).
 */
function parseRoleFilter(raw: string | null): MemberRole[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const parsed: MemberRole[] = [];
  for (const p of parts) {
    const result = MemberRoleSchema.safeParse(p);
    if (result.success) parsed.push(result.data);
  }
  return parsed.length ? parsed : undefined;
}

function parseStatusFilter(raw: string | null): MemberStatus[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const parsed: MemberStatus[] = [];
  for (const p of parts) {
    const result = MemberStatusSchema.safeParse(p);
    if (result.success) parsed.push(result.data);
  }
  return parsed.length ? parsed : undefined;
}

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId);
  if (access.error) return access.error;

  const url = new URL(req.url);
  const roles = parseRoleFilter(url.searchParams.get("role"));
  const statuses = parseStatusFilter(url.searchParams.get("status"));
  const departmentLabel =
    url.searchParams.get("departmentLabel")?.trim() || undefined;
  const q = url.searchParams.get("q")?.trim() || undefined;
  const parsedPagination = ListQuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!parsedPagination.success) {
    return NextResponse.json(
      { error: "Invalid pagination", detail: parsedPagination.error.flatten() },
      { status: 400 },
    );
  }
  const { page, perPage } = parsedPagination.data;

  // Query-param-driven filter; role and status accept lists so the same
  // endpoint serves the sidebar filters (?role=LEARNER) and consultants
  // management (?role=EXPERT&status=ACTIVE) without new routes.
  const where = {
    organizationId: orgId,
    ...(roles && { role: { in: roles } }),
    ...(statuses && { status: { in: statuses } }),
    ...(departmentLabel && { departmentLabel }),
    ...(q && {
      user: {
        OR: [
          { name: { contains: q, mode: "insensitive" as const } },
          { email: { contains: q, mode: "insensitive" as const } },
        ],
      },
    }),
  };

  const [total, data] = await prisma.$transaction([
    prisma.membership.count({ where }),
    prisma.membership.findMany({
      where,
      include: {
        user: {
          select: { id: true, name: true, email: true, image: true },
        },
        // ConsultantProfile + ConsulteeProfile are 1:1 optionals. Always
        // including them here means the consultants page gets
        // `headline / rating / isVerified` in one round-trip without
        // needing a separate /consultants endpoint.
        consultantProfile: {
          select: {
            id: true,
            headline: true,
            rating: true,
            isVerified: true,
          },
        },
        consulteeProfile: {
          select: { id: true },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  return NextResponse.json({
    data,
    meta: { total, page, perPage },
  });
}

/**
 * Direct-add a member by userId. The common add-by-email path goes
 * through /invitations; this endpoint is for admin tooling + SSO
 * auto-provisioning, where we already have a verified userId.
 */
const CreateBodySchema = z.object({
  userId: z.string().min(1),
  role: MemberRoleSchema,
  departmentLabel: z.string().max(100).optional().nullable(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MAINTAINER");
  if (access.error) return access.error;

  const bodyRaw = await req.json().catch(() => null);
  const parsed = CreateBodySchema.safeParse(bodyRaw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { userId, role, departmentLabel } = parsed.data;

  // Consultee/consultant profile links are optional — we populate them
  // if the user has the matching profile, so downstream code that joins
  // via `membership.consulteeProfile` doesn't have to null-check first.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, consulteeProfileId: true, consultantProfileId: true },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Idempotency: a duplicate POST for a currently-active (or pending/
  // suspended) member is a conflict. A REMOVED row is *not* a conflict —
  // that path flips the existing row back to ACTIVE instead of 409'ing
  // (so re-adding someone who was off-boarded doesn't require cleaning up
  // the tombstone first).
  const existing = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId: orgId } },
    select: { id: true, status: true, role: true },
  });

  if (existing && existing.status !== "REMOVED") {
    return NextResponse.json(
      { error: "User is already a member of this organization" },
      { status: 409 },
    );
  }

  const consulteeProfileId =
    role === "LEARNER" ? user.consulteeProfileId ?? null : null;
  const consultantProfileId =
    role === "EXPERT" ? user.consultantProfileId ?? null : null;

  let membership;
  try {
    membership = await prisma.$transaction(async (tx) => {
    if (existing) {
      // Reactivation keeps the same Membership row (preserves downstream
      // FKs on ProgramAssignment / audit trail). That means the LEARNER
      // <-> EXPERT boundary applies here too: a previously-LEARNER user
      // can't be re-added as EXPERT on the same Membership. They need a
      // brand-new Membership, which (given we soft-delete rather than
      // hard-delete) effectively means they can't swap roles inside
      // this org.
      if (
        existing.status === "REMOVED" &&
        isBlockedRoleTransition(existing.role, role)
      ) {
        throw Object.assign(
          new Error("ROLE_TRANSITION_BLOCKED"),
          { httpStatus: 409 },
        );
      }

      // REMOVED → ACTIVE reactivation. Keep the same membership row so
      // downstream FKs (ProgramAssignment, audit trail, etc.) stay intact.
      const reactivated = await tx.membership.update({
        where: { id: existing.id },
        data: {
          role,
          status: "ACTIVE",
          departmentLabel: departmentLabel ?? null,
          consulteeProfileId,
          consultantProfileId,
        },
      });
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          targetMembershipId: reactivated.id,
          category: "MEMBER",
          action: AUDIT_ACTIONS.MEMBER.MEMBER_REACTIVATED,
          description: `Reactivated ${userId} as ${role}`,
          details: { role, departmentLabel: departmentLabel ?? null },
        },
      });
      return reactivated;
    }

    const created = await tx.membership.create({
      data: {
        userId,
        organizationId: orgId,
        role,
        status: "ACTIVE",
        departmentLabel: departmentLabel ?? null,
        consulteeProfileId,
        consultantProfileId,
      },
    });
    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        targetMembershipId: created.id,
        category: "MEMBER",
        action: AUDIT_ACTIONS.MEMBER.MEMBER_ADDED,
        description: `Added ${userId} as ${role}`,
        details: { role, departmentLabel: departmentLabel ?? null },
      },
    });
    return created;
    });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }

  return NextResponse.json(
    { membership },
    { status: existing ? 200 : 201 },
  );
}
