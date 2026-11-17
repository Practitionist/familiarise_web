/**
 * GET  /api/admin/fee-schedules — the take-rate schedule history, paged, and the active rates (STAFF + ADMIN).
 * POST /api/admin/fee-schedules — ADMIN proposes a schedule; another ADMIN approves it (a sole
 * ADMIN may approve their own after 24 hours).
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { readPageParams } from "@/lib/backoffice/list-paging";
import type { FeeSchedulePageInput } from "@/lib/backoffice/people-list-schemas";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal";
import { readActiveFeeSchedule } from "@/lib/payments/pricing/platform-fee";

const bps = z.number().int().min(0).max(10_000);

/** One page of the schedule history, newest first, with the maker and checker named (one batched read). */
export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("payments.read");
  if (auth.error) return auth.error;
  const { page, limit, skip } = readPageParams(req.nextUrl.searchParams, 20);
  const [schedules, total, active] = await Promise.all([
    prisma.platformFeeSchedule.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip,
      take: limit,
    }),
    prisma.platformFeeSchedule.count(),
    readActiveFeeSchedule(prisma),
  ]);
  const ids = [
    ...new Set(
      schedules.flatMap((s) =>
        s.checkerUserId ? [s.makerUserId, s.checkerUserId] : [s.makerUserId],
      ),
    ),
  ];
  const people =
    ids.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, email: true },
        })
      : [];
  const byId = new Map(people.map((p) => [p.id, p]));
  const body: FeeSchedulePageInput = {
    schedules: schedules.map((s) => ({
      id: s.id,
      marketplaceBps: s.marketplaceBps,
      ownLinkBps: s.ownLinkBps,
      effectiveFrom: s.effectiveFrom,
      approvedAt: s.approvedAt,
      createdAt: s.createdAt,
      reason: s.reason,
      maker: byId.get(s.makerUserId) ?? {
        id: s.makerUserId,
        name: null,
        email: null,
      },
      checker: s.checkerUserId
        ? (byId.get(s.checkerUserId) ?? {
            id: s.checkerUserId,
            name: null,
            email: null,
          })
        : null,
    })),
    active: {
      marketplaceBps: active.marketplaceBps,
      ownLinkBps: active.ownLinkBps,
    },
    total,
    page,
    limit,
  };
  return NextResponse.json(body);
}

export const POST = withOpsAction(
  "payments.manage",
  "feeSchedule.propose",
  {
    marketplaceBps: bps,
    ownLinkBps: bps,
    effectiveFrom: z.coerce.date(),
  },
  {
    mode: "tx",
    run: async (tx, ctx) => {
      const { marketplaceBps, ownLinkBps, effectiveFrom } = ctx.body;
      if (ownLinkBps > marketplaceBps) {
        throw new OpsRefusal(
          "OWN_LINK_ABOVE_MARKETPLACE",
          "The own-link rate cannot exceed the marketplace rate.",
          400,
        );
      }
      if (effectiveFrom.getTime() < Date.now()) {
        throw new OpsRefusal(
          "EFFECTIVE_IN_PAST",
          "A schedule can only take effect from now on.",
          400,
        );
      }
      const created = await tx.platformFeeSchedule.create({
        data: {
          marketplaceBps,
          ownLinkBps,
          effectiveFrom,
          makerUserId: ctx.actor.userId,
          reason: ctx.body.reason,
        },
      });
      return {
        target: { kind: "PlatformFeeSchedule", id: created.id },
        response: { schedule: created },
        after: {
          marketplaceBps,
          ownLinkBps,
          effectiveFrom: effectiveFrom.toISOString(),
        },
        status: 201,
      };
    },
  },
);
