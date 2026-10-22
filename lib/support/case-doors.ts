import { z } from "zod";

import type { Tx } from "@/lib/prisma";
import { assertMoneyDoorsOpen } from "@/lib/backoffice/maintenance-gate";
import { withOpsAction, type OpsActor } from "@/lib/backoffice/ops-action-log";
import { UserRoleEnum } from "@/schemas/user";
import {
  ApplyHoldSchema,
  performCaseActionTx,
  ReleaseHoldSchema,
  VoidRecommendationSchema,
  type CaseAction,
} from "./case-actions";
import { rethrowCaseRefusal } from "./refund-door";

const Params = z.object({ caseId: z.string().min(1).max(64) });

const HoldOutcome = z.object({
  holdId: z.string(),
  paymentId: z.string(),
  replayed: z.boolean(),
  consultantEarningIds: z.array(z.string()),
  orgEarningIds: z.array(z.string()),
  cancelledPayoutIds: z.array(z.string()).optional(),
});

/** Payee money net of refunds on the earnings this hold froze or released; 0 for a replay. */
async function heldPaiseOf(
  tx: Tx,
  hold: { consultantEarningIds: string[]; orgEarningIds: string[] },
): Promise<number> {
  const consultant = hold.consultantEarningIds.length
    ? await tx.consultantEarnings.findMany({
        where: { id: { in: hold.consultantEarningIds } },
        select: { consultantSharePaise: true, refundedShareAmount: true },
      })
    : [];
  const org = hold.orgEarningIds.length
    ? await tx.organizationEarnings.findMany({
        where: { id: { in: hold.orgEarningIds } },
        select: { orgSharePaise: true, refundedAmountPaise: true },
      })
    : [];
  const net = (total: number | bigint, refunded: number | bigint) =>
    Math.max(0, Number(total) - Number(refunded));
  return (
    consultant.reduce(
      (sum, row) =>
        sum + net(row.consultantSharePaise, row.refundedShareAmount),
      0,
    ) +
    org.reduce(
      (sum, row) => sum + net(row.orgSharePaise, row.refundedAmountPaise),
      0,
    )
  );
}

async function runCaseAction(
  tx: Tx,
  actor: OpsActor,
  params: Record<string, string>,
  body: CaseAction,
) {
  const { caseId } = Params.parse(params);
  const data = await performCaseActionTx(
    tx,
    caseId,
    { userId: actor.userId, role: UserRoleEnum.parse(actor.role) },
    body,
  ).catch(rethrowCaseRefusal);
  return { caseId, data };
}

async function runHold(
  tx: Tx,
  ctx: {
    actor: OpsActor;
    params: Record<string, string>;
    body: CaseAction;
  },
) {
  await assertMoneyDoorsOpen();
  const { caseId, data } = await runCaseAction(
    tx,
    ctx.actor,
    ctx.params,
    ctx.body,
  );
  const hold = HoldOutcome.parse(data);
  return {
    target: { kind: "Payment", id: hold.paymentId },
    correlationId: `support-case:${caseId}`,
    after: { caseId, ...hold, heldPaise: await heldPaiseOf(tx, hold) },
    response: { data },
  };
}

/** A support-case payout hold: EarningsHold rows of reason SUPPORT_CASE, audited here. */
export const applySupportHoldDoor = withOpsAction(
  "supportHolds.manage",
  "support.hold.apply",
  ApplyHoldSchema.shape,
  { mode: "tx", run: (tx, ctx) => runHold(tx, ctx) },
  { stepUp: true },
);

export const releaseSupportHoldDoor = withOpsAction(
  "supportHolds.manage",
  "support.hold.release",
  ReleaseHoldSchema.shape,
  { mode: "tx", run: (tx, ctx) => runHold(tx, ctx) },
  { stepUp: true },
);

/** Withdraws an approval whose refund failed or never started; no money moves. */
export const voidSupportRecommendationDoor = withOpsAction(
  "refunds.manage",
  "support.recommendation.void",
  VoidRecommendationSchema.shape,
  {
    mode: "tx",
    run: async (tx, { actor, params, body }) => {
      const { caseId } = await runCaseAction(tx, actor, params, body);
      return {
        target: {
          kind: "SupportFinancialRecommendation",
          id: body.recommendationId,
        },
        correlationId: `support-case:${caseId}`,
        after: { caseId, voided: true },
        response: { data: { recommendationId: body.recommendationId } },
      };
    },
  },
  { stepUp: true },
);
