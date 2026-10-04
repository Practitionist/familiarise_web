/**
 * GET  /api/admin/fee-schedules — the take-rate schedule history and the active row (STAFF + ADMIN).
 * POST /api/admin/fee-schedules — ADMIN proposes a schedule; a different ADMIN approves it.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal";
import { readActiveFeeSchedule } from "@/lib/payments/pricing/platform-fee";

const bps = z.number().int().min(0).max(10_000);

export async function GET() {
  const auth = await requireBackofficeSurface("payments.read");
  if (auth.error) return auth.error;
  const [schedules, active] = await Promise.all([
    prisma.platformFeeSchedule.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    readActiveFeeSchedule(prisma),
  ]);
  return NextResponse.json({ schedules, active });
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
