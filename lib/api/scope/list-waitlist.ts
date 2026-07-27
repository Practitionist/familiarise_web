/**
 * Shared list-waitlist query for the #674 / B1-hybrid scope split.
 * Pairs with `lib/api/scope/list-appointments.ts` — same Scope union,
 * same return shape, same auth contract (caller has already
 * authorized).
 */

import prisma from "@/lib/prisma";
import type { Prisma, WaitlistStatus } from "@prisma/client";
import type { Scope } from "./parse";
import { assertNeverScope } from "./parse";

export interface ListWaitlistParams {
  scope: Scope;
  userId: string;
  status?: WaitlistStatus;
  page?: number;
  perPage?: number;
}

export interface ListWaitlistResult {
  items: Awaited<ReturnType<typeof prisma.waitlist.findMany>>;
  total: number;
  page: number;
  perPage: number;
}

function buildWhere(
  params: ListWaitlistParams,
): Prisma.WaitlistWhereInput {
  const base: Prisma.WaitlistWhereInput = {
    ...(params.status && { status: params.status }),
  };
  if (params.scope.kind === "personal") {
    return { ...base, organizationId: null, userId: params.userId };
  }
  if (params.scope.kind === "org") {
    return { ...base, organizationId: params.scope.orgId };
  }
  // `orgMember` = ONE member's own rows within an org. It must never fall
  // through to the unfiltered `base` below: that arm is the `all` scope
  // (admin/staff), and reaching it with an orgMember scope would return the
  // whole platform. `resolveOrgScope` now downgrades a non-operator's
  // ?orgScope=<orgId> to this kind, so the fall-through is live, not latent.
  if (params.scope.kind === "orgMember") {
    return {
      ...base,
      organizationId: params.scope.orgId,
      userId: params.scope.userId,
    };
  }

  // Explicit rather than a fall-through: `base` alone is the admin/staff arm,
  // so an unhandled kind reaching it would return every tenant's rows.
  if (params.scope.kind === "all") return base;

  return assertNeverScope(params.scope);
}

export async function listWaitlistScoped(
  params: ListWaitlistParams,
): Promise<ListWaitlistResult> {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(100, Math.max(1, params.perPage ?? 20));
  const where = buildWhere(params);

  const [total, items] = await prisma.$transaction([
    prisma.waitlist.count({ where }),
    prisma.waitlist.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true } },
        webinar: { select: { id: true, webinarPlan: { select: { title: true } } } },
        class: { select: { id: true, classPlan: { select: { title: true } } } },
        organization: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { joinedAt: "desc" },
      take: perPage,
      skip: (page - 1) * perPage,
    }),
  ]);

  return { items, total, page, perPage };
}
