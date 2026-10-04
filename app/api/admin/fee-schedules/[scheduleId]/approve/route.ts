/**
 * POST /api/admin/fee-schedules/[scheduleId]/approve — the checker half of maker-checker:
 * an ADMIN other than the proposer approves a pending schedule (CAS on approvedAt).
 */
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal";

export const POST = withOpsAction(
  "payments.manage",
  "feeSchedule.approve",
  {},
  {
    mode: "tx",
    run: async (tx, ctx) => {
      const id = ctx.params.scheduleId;
      const row = id
        ? await tx.platformFeeSchedule.findUnique({ where: { id } })
        : null;
      if (!row) {
        throw new OpsRefusal("NOT_FOUND", "Fee schedule not found.", 404);
      }
      if (row.makerUserId === ctx.actor.userId) {
        throw new OpsRefusal(
          "SAME_PERSON",
          "The person who proposed a fee schedule cannot approve it.",
          409,
        );
      }
      const now = new Date();
      const approved = await tx.platformFeeSchedule.updateMany({
        where: {
          id: row.id,
          approvedAt: null,
          makerUserId: { not: ctx.actor.userId },
        },
        data: { approvedAt: now, checkerUserId: ctx.actor.userId },
      });
      if (approved.count !== 1) {
        throw new OpsRefusal(
          "ALREADY_APPROVED",
          "This fee schedule is already approved.",
          409,
        );
      }
      return {
        target: { kind: "PlatformFeeSchedule", id: row.id },
        response: {
          schedule: {
            ...row,
            approvedAt: now,
            checkerUserId: ctx.actor.userId,
          },
        },
        before: { approvedAt: null },
        after: {
          approvedAt: now.toISOString(),
          checkerUserId: ctx.actor.userId,
          marketplaceBps: row.marketplaceBps,
          ownLinkBps: row.ownLinkBps,
          effectiveFrom: row.effectiveFrom.toISOString(),
        },
      };
    },
  },
);
