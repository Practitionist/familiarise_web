/**
 * GET /api/org-workspace/[orgWorkspaceId]/activity
 *
 * Cross-org audit feed for an OrgWorkspace. Aggregates `OrgAuditLog` rows
 * from every org where the caller has an ACTIVE OWNER membership and
 * stitches them into a single timeline. Distinct from the per-org
 * /audit endpoint which scopes to one org and supports rich filters.
 * This one is intentionally simpler: latest-first, no filtering, used
 * to drive a "what changed across my portfolio in the last week"
 * widget.
 *
 * Pagination: cursor on `(createdAt DESC, id DESC)`. The
 * `@@index([organizationId, createdAt])` covers the per-org slice;
 * Postgres composes them via the `IN` clause without a new index.
 *
 * Auth: same IDOR posture as /billing — orgWorkspaceId in URL must match
 * the caller's `orgWorkspaceProfileId`.
 *
 * Returns enriched rows: each row carries the orgName + actor's display
 * name so the UI doesn't need a follow-up join.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgWorkspaceId: string }> },
) {
  const { orgWorkspaceId } = await params;
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;

  // `orgWorkspaceProfileId` is part of the customSession-augmented user
  // type (lib/auth.ts:522) — direct access is type-safe.
  if (auth.session.user.orgWorkspaceProfileId !== orgWorkspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const q = parsed.data;

  const ownedOrgs = await prisma.membership.findMany({
    where: {
      userId: auth.session.user.id,
      role: "OWNER",
      status: "ACTIVE",
    },
    select: {
      organizationId: true,
      organization: { select: { id: true, name: true, slug: true } },
    },
  });
  const orgIds = ownedOrgs.map((o) => o.organizationId);
  const orgById = new Map(ownedOrgs.map((o) => [o.organizationId, o.organization]));

  if (orgIds.length === 0) {
    return NextResponse.json({
      data: [],
      pagination: { hasMore: false, nextCursor: null, limit: q.limit },
    });
  }

  const rows = await prisma.orgAuditLog.findMany({
    where: { organizationId: { in: orgIds } },
    orderBy: { createdAt: "desc" },
    take: q.limit + 1,
    ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
    select: {
      id: true,
      organizationId: true,
      actorMembershipId: true,
      category: true,
      action: true,
      description: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > q.limit;
  const slice = hasMore ? rows.slice(0, q.limit) : rows;
  const nextCursor = hasMore ? slice[slice.length - 1]?.id ?? null : null;

  // Actor names — OrgAuditLog has no Prisma relation back to Membership
  // (the FK column is bare), so a single batched lookup keyed on the
  // distinct actorMembershipIds beats N+1 round-trips.
  const actorIds = Array.from(
    new Set(slice.map((r) => r.actorMembershipId).filter((v): v is string => !!v)),
  );
  const actors = actorIds.length
    ? await prisma.membership.findMany({
        where: { id: { in: actorIds } },
        select: {
          id: true,
          user: { select: { name: true, email: true } },
        },
      })
    : [];
  const actorById = new Map(actors.map((a) => [a.id, a]));

  const data = slice.map((r) => {
    const org = orgById.get(r.organizationId);
    const actor = r.actorMembershipId
      ? actorById.get(r.actorMembershipId)
      : undefined;
    return {
      id: r.id,
      organizationId: r.organizationId,
      organizationName: org?.name ?? null,
      organizationSlug: org?.slug ?? null,
      category: r.category,
      action: r.action,
      description: r.description,
      createdAt: r.createdAt,
      actorName: actor?.user?.name ?? actor?.user?.email ?? null,
    };
  });

  return NextResponse.json({
    data,
    pagination: { hasMore, nextCursor, limit: q.limit },
  });
}
