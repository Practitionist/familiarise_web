/**
 * POST /api/admin/fee-schedules/[scheduleId]/approve — the checker half of maker-checker
 * (CAS on approvedAt). Another ADMIN approves; while exactly one active ADMIN exists, the
 * proposer may approve their own schedule 24 hours after proposing it, with a reason.
 */
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal";
import {
  feeScheduleApprovalRefusal,
  SELF_APPROVAL_WAIT_MS,
} from "@/lib/payments/pricing/platform-fee";

const REFUSAL_COPY = {
  SAME_PERSON:
    "With more than one admin, a fee schedule must be approved by an admin other than the one who proposed it.",
  SELF_APPROVAL_TOO_SOON:
    "As the only admin you can approve your own fee schedule, but only 24 hours after proposing it.",
} as const;

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
      const now = new Date();
      const selfApproval = row.makerUserId === ctx.actor.userId;
      const refusal = feeScheduleApprovalRefusal({
        makerUserId: row.makerUserId,
        checkerUserId: ctx.actor.userId,
        createdAt: row.createdAt,
        activeAdmins: selfApproval
          ? await tx.user.count({ where: { role: "ADMIN", banned: false } })
          : 0,
        now,
      });
      if (refusal) {
        throw new OpsRefusal(refusal, REFUSAL_COPY[refusal], 409);
      }
      const approved = await tx.platformFeeSchedule.updateMany({
        where: {
          id: row.id,
          approvedAt: null,
          ...(selfApproval
            ? {
                createdAt: {
                  lte: new Date(now.getTime() - SELF_APPROVAL_WAIT_MS),
                },
              }
            : { makerUserId: { not: ctx.actor.userId } }),
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
          selfApproval,
          marketplaceBps: row.marketplaceBps,
          ownLinkBps: row.ownLinkBps,
          effectiveFrom: row.effectiveFrom.toISOString(),
        },
      };
    },
  },
);
