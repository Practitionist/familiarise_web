/**
 * GET  /api/organizations/[orgId]/programs/[programId]/assignments
 * POST /api/organizations/[orgId]/programs/[programId]/assignments
 *
 * Per-member program entitlements. GET lists assignments for the
 * program; POST creates one via `claimProgramAssignment`, which handles
 * the upsert + period uniqueness invariant.
 *
 * Activating a LICENSED_SEAT assignment bumps `activeSeatCount` on the
 * config — the enforcement happens on the next billing cycle when
 * generate-subscription-invoices reads this value.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import {
  claimProgramAssignment,
  ProgramAssignmentOverlapError,
} from "@/lib/api/organizations/program-helpers";
import { adjustActiveSeatCount } from "@/lib/api/organizations/seat-count";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { withSerializableRetry } from "@/lib/db/serializable-retry";

const CreateBodySchema = z
  .object({
    membershipId: z.string().min(1).optional(),
    membershipIds: z.array(z.string().min(1)).min(1).max(100).optional(),
    periodStart: z.coerce.date(),
    periodEnd: z.coerce.date(),
  })
  .refine(
    (data) =>
      Boolean(data.membershipId) ||
      Boolean(data.membershipIds && data.membershipIds.length > 0),
    {
      message: "membershipId or membershipIds is required",
      path: ["membershipId"],
    },
  );

export async function GET(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; programId: string }>;
  },
) {
  const { orgId, programId } = await params;
  // Any ACTIVE member may call this, but the roster (every assignee's name,
  // email and spend) is `programs.read`; everyone else gets only their own
  // rows, without consumedPaise (#1527 P0-2).
  const access = await requireOrgAccess(orgId, { readOnly: true });
  if (access.error) return access.error;
  if (!access.org.canSponsor) {
    return NextResponse.json(
      { error: "Organization does not sponsor programs" },
      { status: 404 },
    );
  }

  // Belt-and-braces: don't leak assignments from a program in a
  // sibling org even if the caller knows the programId.
  const program = await prisma.program.findFirst({
    where: { id: programId, contract: { organizationId: orgId } },
    select: { id: true },
  });
  if (!program) {
    return NextResponse.json({ error: "Program not found" }, { status: 404 });
  }

  const canReadAll = hasOrgPermission(access.member.role, "programs.read");
  const url = new URL(req.url);
  const membershipId = canReadAll
    ? (url.searchParams.get("membershipId") ?? undefined)
    : access.member.id;

  const assignments = await prisma.programAssignment.findMany({
    where: {
      programId,
      ...(membershipId && { membershipId }),
    },
    include: {
      membership: {
        select: {
          id: true,
          role: true,
          user: { select: { id: true, name: true, email: true } },
        },
      },
    },
    orderBy: { periodStart: "desc" },
  });

  return NextResponse.json({
    data: canReadAll
      ? assignments
      : assignments.map(({ consumedPaise: _spend, ...own }) => own),
  });
}

export async function POST(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; programId: string }>;
  },
) {
  const { orgId, programId } = await params;
  // Seat assign/unassign is programs.assign (OWNER, MAINTAINER, MANAGER).
  const access = await requireOrgAccess(orgId, {
    permission: "programs.assign",
    canSponsor: true,
    requireActive: true,
  });
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = CreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;
  if (body.periodEnd.getTime() <= body.periodStart.getTime()) {
    return NextResponse.json(
      { error: "periodEnd must be after periodStart" },
      { status: 400 },
    );
  }

  const targetMembershipIds = Array.from(
    new Set(
      body.membershipIds ?? (body.membershipId ? [body.membershipId] : []),
    ),
  );

  // Cross-org guards: program in this org, membership in this org.
  // One trip to the DB per object keeps the error messages specific —
  // a single findFirst union would surface a generic "not found".
  const program = await prisma.program.findFirst({
    where: { id: programId, contract: { organizationId: orgId } },
    select: { id: true, status: true },
  });
  if (!program) {
    return NextResponse.json({ error: "Program not found" }, { status: 404 });
  }
  if (program.status !== "ACTIVE") {
    return NextResponse.json(
      { error: `Cannot assign to a ${program.status} program` },
      { status: 409 },
    );
  }

  // Serializable shares the conflict boundary with the PATCH money-config tx
  // (which re-checks configLockedAt in-scope). Batched reads/writes keep the
  // round-trip count O(1) across 100 members on PG_POOL_MAX=1.
  try {
    const outcome = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          if (targetMembershipIds.length === 1) {
            const singleMembershipId = targetMembershipIds[0];
            const membership = await tx.membership.findFirst({
              where: { id: singleMembershipId, organizationId: orgId },
              select: { id: true, status: true },
            });
            if (!membership) {
              return {
                ok: false as const,
                code: "FOREIGN" as const,
                membershipId: singleMembershipId,
              };
            }
            if (membership.status !== "ACTIVE") {
              return {
                ok: false as const,
                code: "INACTIVE" as const,
                status: membership.status,
                membershipId: singleMembershipId,
              };
            }

            const { assignment, created } = await claimProgramAssignment(tx, {
              programId,
              membershipId: singleMembershipId,
              periodStart: body.periodStart,
              periodEnd: body.periodEnd,
            });
            if (created) {
              await adjustActiveSeatCount(tx, { programId, delta: 1 });
              await tx.program.updateMany({
                where: { id: programId, configLockedAt: null },
                data: { configLockedAt: new Date() },
              });
              const endpoints = await tx.webhookEndpoint.findMany({
                where: {
                  organizationId: orgId,
                  status: "ACTIVE",
                  eventSubscriptions: { has: "program.assigned" },
                },
                select: { id: true },
              });
              if (endpoints.length > 0) {
                await tx.outboundWebhookDelivery.createMany({
                  data: endpoints.map((endpoint) => ({
                    webhookEndpointId: endpoint.id,
                    eventType: "program.assigned",
                    payload: {
                      assignmentId: assignment.id,
                      programId,
                      membershipId: singleMembershipId,
                      periodStart: body.periodStart.toISOString(),
                      periodEnd: body.periodEnd.toISOString(),
                    } satisfies Prisma.InputJsonValue,
                    status: "PENDING" as const,
                  })),
                });
              }
            }
            await tx.orgAuditLog.create({
              data: {
                organizationId: orgId,
                actorMembershipId: access.member.id,
                targetMembershipId: singleMembershipId,
                category: "PROGRAM",
                action: AUDIT_ACTIONS.PROGRAM.PROGRAM_ASSIGNED,
                description: `Assigned membership ${singleMembershipId} to program ${programId}`,
                details: {
                  programId,
                  membershipId: singleMembershipId,
                  periodStart: body.periodStart.toISOString(),
                  periodEnd: body.periodEnd.toISOString(),
                },
              },
            });
            return {
              ok: true as const,
              assignment,
              assignments: [assignment],
            };
          }

          const foundMemberships = await tx.membership.findMany({
            where: { id: { in: targetMembershipIds }, organizationId: orgId },
            select: { id: true, status: true },
          });
          const membershipById = new Map(
            foundMemberships.map((m) => [m.id, m]),
          );
          for (const targetMembershipId of targetMembershipIds) {
            const membership = membershipById.get(targetMembershipId);
            if (!membership) {
              return {
                ok: false as const,
                code: "FOREIGN" as const,
                membershipId: targetMembershipId,
              };
            }
            if (membership.status !== "ACTIVE") {
              return {
                ok: false as const,
                code: "INACTIVE" as const,
                status: membership.status,
                membershipId: targetMembershipId,
              };
            }
          }

          const overlapping = await tx.programAssignment.findFirst({
            where: {
              programId,
              membershipId: { in: targetMembershipIds },
              status: "ACTIVE",
              periodStart: { lt: body.periodEnd, not: body.periodStart },
              periodEnd: { gt: body.periodStart },
            },
            select: { membershipId: true },
          });
          if (overlapping) {
            throw new ProgramAssignmentOverlapError(
              programId,
              overlapping.membershipId,
            );
          }

          const existingExact = await tx.programAssignment.findMany({
            where: {
              programId,
              membershipId: { in: targetMembershipIds },
              periodStart: body.periodStart,
            },
            select: { membershipId: true },
          });
          const existingExactSet = new Set(
            existingExact.map((e) => e.membershipId),
          );

          const ins = await tx.programAssignment.createMany({
            data: targetMembershipIds.map((membershipId) => ({
              programId,
              membershipId,
              periodStart: body.periodStart,
              periodEnd: body.periodEnd,
            })),
            skipDuplicates: true,
          });
          const createdCount = ins.count;

          const rows = await tx.programAssignment.findMany({
            where: {
              programId,
              membershipId: { in: targetMembershipIds },
              periodStart: body.periodStart,
            },
          });
          const rowByMembershipId = new Map(
            rows.map((r) => [r.membershipId, r]),
          );
          const createdAssignments = targetMembershipIds
            .map((id) => rowByMembershipId.get(id))
            .filter((r): r is NonNullable<typeof r> => Boolean(r));

          await tx.orgAuditLog.createMany({
            data: targetMembershipIds.map((targetMembershipId) => ({
              organizationId: orgId,
              actorMembershipId: access.member.id,
              targetMembershipId,
              category: "PROGRAM" as const,
              action: AUDIT_ACTIONS.PROGRAM.PROGRAM_ASSIGNED,
              description: `Assigned membership ${targetMembershipId} to program ${programId}`,
              details: {
                programId,
                membershipId: targetMembershipId,
                periodStart: body.periodStart.toISOString(),
                periodEnd: body.periodEnd.toISOString(),
              },
            })),
          });

          const newlyCreatedAssignments = createdAssignments.filter(
            (a) => !existingExactSet.has(a.membershipId),
          );
          if (newlyCreatedAssignments.length > 0) {
            const endpoints = await tx.webhookEndpoint.findMany({
              where: {
                organizationId: orgId,
                status: "ACTIVE",
                eventSubscriptions: { has: "program.assigned" },
              },
              select: { id: true },
            });
            if (endpoints.length > 0) {
              await tx.outboundWebhookDelivery.createMany({
                data: newlyCreatedAssignments.flatMap((created) =>
                  endpoints.map((endpoint) => ({
                    webhookEndpointId: endpoint.id,
                    eventType: "program.assigned",
                    payload: {
                      assignmentId: created.id,
                      programId,
                      membershipId: created.membershipId,
                      periodStart: body.periodStart.toISOString(),
                      periodEnd: body.periodEnd.toISOString(),
                    } satisfies Prisma.InputJsonValue,
                    status: "PENDING" as const,
                  })),
                ),
              });
            }
          }

          if (createdCount > 0) {
            await adjustActiveSeatCount(tx, {
              programId,
              delta: createdCount,
            });
            await tx.program.updateMany({
              where: { id: programId, configLockedAt: null },
              data: { configLockedAt: new Date() },
            });
          }

          return {
            ok: true as const,
            assignment: createdAssignments[0],
            assignments: createdAssignments,
          };
        },
        { isolationLevel: "Serializable" },
      ),
    );

    if (!outcome.ok) {
      if (outcome.code === "FOREIGN") {
        return NextResponse.json(
          {
            error: "Membership does not belong to this organization",
            code: "MEMBERSHIP_FOREIGN",
            ...(body.membershipIds
              ? { membershipId: outcome.membershipId }
              : {}),
          },
          { status: 400 },
        );
      }
      return NextResponse.json(
        {
          error: `Cannot assign a ${outcome.status} membership to a program`,
          code: "MEMBERSHIP_NOT_ACTIVE",
          ...(body.membershipIds ? { membershipId: outcome.membershipId } : {}),
        },
        { status: 409 },
      );
    }

    return NextResponse.json(
      { assignment: outcome.assignment, assignments: outcome.assignments },
      { status: 201 },
    );
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === "ProgramAssignmentOverlapError" &&
      "membershipId" in err
    ) {
      return NextResponse.json(
        {
          error: err.message,
          code: "ASSIGNMENT_OVERLAP",
          membershipId: err.membershipId,
        },
        { status: 409 },
      );
    }
    throw err;
  }
}
