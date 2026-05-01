/**
 * Shared list-trials query for the #674 / B1-hybrid scope split.
 * `TrialSession.organizationId` already exists (predates #674) — this
 * helper just routes the same scope dimension that the other resources
 * use.
 */

import prisma from "@/lib/prisma";
import type { Prisma, TrialSessionStatus } from "@prisma/client";
import type { Scope } from "./parse";

export interface ListTrialsParams {
  scope: Scope;
  userId: string;
  status?: TrialSessionStatus;
  page?: number;
  perPage?: number;
}

export interface ListTrialsResult {
  items: Awaited<ReturnType<typeof prisma.trialSession.findMany>>;
  total: number;
  page: number;
  perPage: number;
}

function buildWhere(
  params: ListTrialsParams,
): Prisma.TrialSessionWhereInput {
  const base: Prisma.TrialSessionWhereInput = {
    ...(params.status && { status: params.status }),
  };
  if (params.scope.kind === "personal") {
    return {
      ...base,
      organizationId: null,
      OR: [
        { consulteeProfile: { userId: params.userId } },
        { consultantProfile: { userId: params.userId } },
      ],
    };
  }
  if (params.scope.kind === "org") {
    return { ...base, organizationId: params.scope.orgId };
  }
  return base;
}

export async function listTrialsScoped(
  params: ListTrialsParams,
): Promise<ListTrialsResult> {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(100, Math.max(1, params.perPage ?? 20));
  const where = buildWhere(params);

  const [total, items] = await prisma.$transaction([
    prisma.trialSession.count({ where }),
    prisma.trialSession.findMany({
      where,
      include: {
        consulteeProfile: {
          select: { user: { select: { id: true, name: true, email: true } } },
        },
        consultantProfile: {
          select: { user: { select: { id: true, name: true, email: true } } },
        },
        subscriptionPlan: { select: { title: true } },
        organization: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { requestedAt: "desc" },
      take: perPage,
      skip: (page - 1) * perPage,
    }),
  ]);

  return { items, total, page, perPage };
}
