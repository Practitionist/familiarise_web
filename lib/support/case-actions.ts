import {
  Prisma,
  type SupportCase,
  type SupportCaseDecision,
  type SupportCaseEventKind,
  type UserRole,
} from "@prisma/client";
import { z } from "zod";
import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import {
  hasBackofficePermission,
  type BackofficeSurface,
} from "@/lib/auth/backoffice-permissions";
import { canCorrespondOnCase, caseCorrespondentIds } from "./case-access";
import { reverseAppealedModeration } from "./appeal-reversal";
import { purgeReviewSurfaces } from "@/lib/data/public-cache";
import {
  caseDecidedDetail,
  executePatchLifecycleTx,
  latestCaseDecisionTx,
} from "./case-service";
import { stageBell } from "@/lib/novu/stage-bell";
import { NOVU_WORKFLOWS, notificationScope } from "@/lib/novu/workflows";
import { supportRequestHref } from "@/lib/novu/resolve-href";
import { caseKeyOf } from "./case-key";
import { stageExternalRequesterEmail } from "./external-requester";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import { proposalStatusWhere } from "@/lib/backoffice/ops-proposals";
import { refundInFlightOr } from "@/lib/backoffice/refund-doors";
import {
  CaseRefundReviewSchema,
  hasRefundablePreview,
  REFUNDABLE_PREVIEW_REQUIRED,
} from "@/schemas/support-refund-review";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
import {
  fundingRailForIntent,
  type FundingRail,
} from "@/lib/payments/funding-rail";
import { creditStillUsedPaise } from "@/lib/payments/operations/credit-plan-return";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import {
  assertBoundedRefund,
  assertNotOwnRemedy,
  committedSupportPaiseByPayment,
  SUPPORT_REFUND_SEND_GRACE_MS,
} from "./money-policy";
import { STAFF_REFUND_PER_PAYMENT_PAISE } from "./staff-refund-limits";
import { deliveringPartiesByAppointment } from "./evidence-parties";
import {
  planRefundBasis,
  removePlanSessions,
  restorePlanSessions,
  type PlanSessionsChange,
} from "@/lib/booking/plan-refund";
import { sessionShareOf } from "@/lib/booking/entitlement";
import {
  activeHolds,
  caseHoldEvents,
  holdPaymentForCase,
  releaseCaseHoldRows,
} from "./case-holds";
import {
  conductRemovalDecidedTx,
  settleDecidedRemoval,
} from "./conduct-removal-case";
import {
  CONDUCT_REMOVAL_CATEGORY,
  reviewedRemovalCaseId,
} from "./conduct-removal-state";

const id = z.string().min(1).max(128);
const reason = z.string().trim().min(1).max(10_000);
const base = z.object({
  clientActionId: id,
  expectedUpdatedAt: z.string().datetime(),
});
export const ApplyHoldSchema = base.extend({
  action: z.literal("APPLY_HOLD"),
  paymentId: id,
  reason,
});
export const ReleaseHoldSchema = base.extend({
  action: z.literal("RELEASE_HOLD"),
  holdId: id,
  reason,
});
export const VoidRecommendationSchema = base.extend({
  action: z.literal("VOID_RECOMMENDATION"),
  recommendationId: id,
  reason,
});
export const CaseActionSchema = z.discriminatedUnion("action", [
  base.extend({
    action: z.literal("REQUEST_EVIDENCE"),
    recipientUserId: id,
    prompt: reason,
    dueAt: z.string().datetime().optional(),
  }),
  base.extend({ action: z.literal("CANCEL_EVIDENCE"), requestId: id, reason }),
  base.extend({
    action: z.literal("DECIDE"),
    outcome: z.enum([
      "NO_REMEDY",
      "SERVICE_REMEDY",
      "REFUND_APPROVED",
      "REFUND_DECLINED",
      "UPHELD",
      "OVERTURNED",
    ]),
    explanation: reason,
    privateRationale: reason.optional(),
    /** An admin correction names the decision in force; omitted for the first decision. */
    supersedesDecisionId: id.optional(),
  }),
  base.extend({
    action: z.literal("RECOMMEND_REFUND"),
    paymentId: id,
    amountPaise: z.number().int().nonnegative().safe(),
    reason,
    /** Cancels the remaining service when executed; by default the seat stays. */
    releaseSeat: z.boolean().default(false),
    /**
     * Plan sessions this remedy removes; the amount must then be their share
     * of the price, floor(paid × sessions / sessions sold).
     */
    sessions: z.number().int().min(1).max(1000).optional(),
  }),
  CaseRefundReviewSchema,
  VoidRecommendationSchema,
  ApplyHoldSchema,
  ReleaseHoldSchema,
]);
/** The route's parse: an approval must carry the refundable balance it previewed. */
export const CaseActionRequestSchema = CaseActionSchema.superRefine(
  (body, ctx) => {
    if (body.action === "REVIEW_REFUND" && !hasRefundablePreview(body))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedRefundablePaise"],
        message: REFUNDABLE_PREVIEW_REQUIRED,
      });
  },
);
export type CaseAction = z.infer<typeof CaseActionSchema>;
export type CaseActor = {
  userId: string;
  role: UserRole | null;
  /** Re-authenticated within the step-up window; a decision that releases payout holds needs it. */
  freshSession?: boolean;
};

export class CaseActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    /** Extra fields for the response body, such as the decision in force. */
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CaseActionError";
  }
}

export async function assertIndependentReviewer(
  tx: Tx,
  supportCase: {
    appealOfDecisionId: string | null;
    appealOfModerationActionId: string | null;
  },
  reviewerId: string,
) {
  const original = supportCase.appealOfDecisionId
    ? await tx.supportCaseDecision.findUnique({
        where: { id: supportCase.appealOfDecisionId },
        select: { decidedById: true },
      })
    : null;
  const moderation = supportCase.appealOfModerationActionId
    ? await tx.moderationAction.findUnique({
        where: { id: supportCase.appealOfModerationActionId },
        select: { takenById: true },
      })
    : null;
  if (
    original?.decidedById === reviewerId ||
    moderation?.takenById === reviewerId
  ) {
    throw new CaseActionError(
      "INDEPENDENT_REVIEW_REQUIRED",
      "A different eligible operator must review this appeal.",
      403,
    );
  }
}

/** A typed audit row on the case timeline; `toValue` names the row it acted on. */
async function caseEvent(
  tx: Tx,
  caseId: string,
  actorId: string,
  kind: SupportCaseEventKind,
  toValue: string,
  note?: string,
) {
  await tx.supportCaseEvent.create({
    data: { caseId, actorId, kind, toValue, note, createdAt: new Date() },
  });
}

export async function stageCaseNotice(
  tx: Tx,
  supportCase: {
    id: string;
    referenceNumber: string;
    title: string;
    organizationId: string | null;
  },
  recipients: string[],
  message: string,
  key: string,
) {
  await stageBell(tx, {
    workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_UPDATE,
    recipients,
    dedupeKey: key,
    entityRef: key,
    payload: {
      ticketId: supportCase.id,
      reference: supportCase.referenceNumber,
      ticketTitle: supportCase.title,
      status: message,
      dashboardUrl: supportRequestHref(
        caseKeyOf({ kind: "case", id: supportCase.id }),
        supportCase.organizationId,
      ),
      ...notificationScope(supportCase.organizationId),
    },
  });
}

function financialPaymentScope(
  supportCase: Pick<
    SupportCase,
    "ownershipScope" | "requesterUserId" | "organizationId"
  >,
): Prisma.PaymentWhereInput {
  if (supportCase.ownershipScope === "PERSONAL")
    return { userId: supportCase.requesterUserId };
  const organizationId = supportCase.organizationId ?? "";
  if (supportCase.ownershipScope === "ORG_BILLING")
    return { billingAccount: { ownerOrgId: organizationId } };
  return {
    OR: [
      { billingAccount: { ownerOrgId: organizationId } },
      { hostOrganizationId: organizationId },
      { organizationEarnings: { some: { organizationId } } },
    ],
  };
}

async function linkedPayment(tx: Tx, caseId: string, paymentId: string) {
  const supportCase = await tx.supportCase.findUniqueOrThrow({
    where: { id: caseId },
    select: {
      appointmentId: true,
      requesterUserId: true,
      ownershipScope: true,
      organizationId: true,
    },
  });
  const subject = await tx.supportCaseSubject.findFirst({
    where: { caseId, subjectType: "PAYMENT", subjectId: paymentId },
    select: { id: true },
  });
  const financialScope = financialPaymentScope(supportCase);
  const payment = await tx.payment.findFirst({
    where: {
      ...financialScope,
      id: paymentId,
      deletedAt: null,
      ...(!subject ? { appointmentId: supportCase.appointmentId ?? "" } : {}),
    },
    select: {
      id: true,
      amount: true,
      paymentIntent: true,
      paymentStatus: true,
      ...REFUNDABLE_BALANCE_SELECT,
    },
  });
  if (!payment)
    throw new CaseActionError(
      "PAYMENT_NOT_LINKED",
      "Choose a payment linked to this case.",
      404,
    );
  return payment;
}

type EvidenceRecipientDb = Pick<
  Tx,
  "appointment" | "consultantProfile" | "membership" | "user"
>;

/**
 * Current evidence parties per appointment: the delivering parties plus the
 * host organization's operators. Pure reads: pass `prisma` outside a
 * transaction, `tx` inside one.
 */
export async function evidenceRecipientsByAppointment(
  db: EvidenceRecipientDb,
  appointmentIds: readonly string[],
): Promise<Map<string, { id: string; name: string }[]>> {
  const result = new Map<string, { id: string; name: string }[]>();
  if (appointmentIds.length === 0) return result;
  const parties = await deliveringPartiesByAppointment(db, appointmentIds);
  const allHostIds = [
    ...new Set(
      [...parties.values()].flatMap((p) => [...p.hostOrganizationIds]),
    ),
  ];
  const operators = allHostIds.length
    ? await db.membership.findMany({
        where: {
          organizationId: { in: allHostIds },
          status: "ACTIVE",
          role: { in: ["OWNER", "MAINTAINER", "MANAGER", "SUPPORT"] },
        },
        select: { organizationId: true, userId: true },
      })
    : [];
  const peopleByBooking = new Map(
    [...parties].map(([bookingId, booking]) => {
      const people = new Set(booking.deliveringIds);
      for (const m of operators)
        if (booking.hostOrganizationIds.has(m.organizationId))
          people.add(m.userId);
      return [bookingId, people] as const;
    }),
  );
  const everyone = [
    ...new Set([...peopleByBooking.values()].flatMap((p) => [...p])),
  ];
  const users = everyone.length
    ? await db.user.findMany({
        where: { id: { in: everyone }, banned: { not: true } },
        select: { id: true, name: true },
      })
    : [];
  for (const [bookingId, people] of peopleByBooking)
    result.set(
      bookingId,
      users.filter((user) => people.has(user.id)),
    );
  return result;
}

export async function evidenceRecipients(
  db: EvidenceRecipientDb,
  appointmentId: string | null,
) {
  if (!appointmentId) return [];
  const byAppointment = await evidenceRecipientsByAppointment(db, [
    appointmentId,
  ]);
  return byAppointment.get(appointmentId) ?? [];
}

const LIVE_REFUND_STATUSES = new Set(["PENDING", "SUCCEEDED"]);

/** A refund that moved money or is about to; FAILED and CANCELLED moved none. */
function isLiveRefund(refund: { status: string } | null): boolean {
  return refund !== null && LIVE_REFUND_STATUSES.has(refund.status);
}

type HoldSummary = {
  id: string;
  paymentId: string;
  reason: string;
  createdAt: Date;
  releasedAt: Date | null;
  /** Unpaid earnings this hold freezes now; 0 once released or when none were unpaid. */
  earningsHeld: number;
};

async function readCaseHolds(tx: Tx, caseId: string): Promise<HoldSummary[]> {
  const events = await caseHoldEvents(tx, [caseId]);
  const rows = await tx.earningsHold.findMany({
    where: { reason: "SUPPORT_CASE", sourceRef: caseId, releasedAt: null },
    select: {
      consultantEarnings: { select: { paymentId: true } },
      organizationEarnings: { select: { paymentId: true } },
    },
  });
  const heldByPayment = new Map<string, number>();
  for (const row of rows) {
    const paymentId =
      row.consultantEarnings?.paymentId ?? row.organizationEarnings?.paymentId;
    if (paymentId)
      heldByPayment.set(paymentId, (heldByPayment.get(paymentId) ?? 0) + 1);
  }
  const open = new Map<string, HoldSummary>();
  const holds: HoldSummary[] = [];
  for (const event of [...events].reverse()) {
    if (!event.toValue) continue;
    if (event.kind === "HOLD_APPLIED") {
      const hold: HoldSummary = {
        id: event.id,
        paymentId: event.toValue,
        reason: event.note ?? "",
        createdAt: event.createdAt,
        releasedAt: null,
        earningsHeld: 0,
      };
      open.set(event.toValue, hold);
      holds.push(hold);
    } else {
      const hold = open.get(event.toValue);
      if (hold) hold.releasedAt = event.createdAt;
      open.delete(event.toValue);
    }
  }
  for (const hold of open.values())
    hold.earningsHeld = heldByPayment.get(hold.paymentId) ?? 0;
  return holds.reverse();
}

/**
 * The case booking's captured plan payment and how many sessions can still
 * come off it; null when that payment is outside the case's financial scope.
 */
async function casePlanRefund(
  supportCase: Pick<
    SupportCase,
    "id" | "ownershipScope" | "requesterUserId" | "organizationId"
  >,
  appointmentId: string,
) {
  const payment = await prisma.payment.findFirst({
    where: {
      ...financialPaymentScope(supportCase),
      appointmentId,
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
      appointment: { subscriptionId: { not: null } },
    },
    select: { id: true, amount: true, paymentIntent: true },
  });
  if (!payment || payment.paymentIntent.startsWith("free_")) return null;
  const basis = await planRefundBasis(prisma, payment.id);
  if (!basis) return null;
  const quote = await prisma.$transaction((tx) =>
    quoteCaseRefund(tx, supportCase.id, { id: "", paymentId: payment.id }),
  );
  return {
    paymentId: payment.id,
    amountPaise: Number(payment.amount),
    refundablePaise: quote.refundablePaise,
    sessionsTotal: basis.sessionsTotal,
    sessionsRefunded: basis.sessionsRefunded,
    removable: basis.removable,
  };
}

export async function readCaseResolution(caseId: string, actor: CaseActor) {
  const supportCase = await prisma.supportCase.findFirst({
    where: { id: caseId, deletedAt: null },
  });
  if (!supportCase || !(await canCorrespondOnCase(supportCase, actor)))
    return null;
  const staff = hasBackofficePermission(actor.role, "tickets.manage");
  const moneyRead = hasBackofficePermission(actor.role, "payments.read");
  const [decisions, recommendations, holds, requests, recipients] =
    await prisma.$transaction(async (tx) =>
      Promise.all([
        tx.supportCaseDecision.findMany({
          where: { caseId },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            outcome: true,
            explanation: true,
            createdAt: true,
            appealUntil: true,
            supersedesDecisionId: true,
            ...(staff ? { privateRationale: true, decidedById: true } : {}),
          },
        }),
        moneyRead
          ? tx.supportFinancialRecommendation.findMany({
              where: { caseId },
              include: {
                refund: {
                  select: { id: true, status: true, amountPaise: true },
                },
              },
              orderBy: { createdAt: "desc" },
            })
          : [],
        moneyRead ? readCaseHolds(tx, caseId) : [],
        staff
          ? tx.supportCaseEvidenceRequest.findMany({
              where: { caseId },
              orderBy: { createdAt: "desc" },
            })
          : [],
        staff ? evidenceRecipients(tx, supportCase.appointmentId) : [],
      ]),
    );
  const pendingApprovals = recommendations.length
    ? await prisma.opsActionProposal.findMany({
        where: {
          ...proposalStatusWhere("PROPOSED", new Date()),
          targetKind: "SupportFinancialRecommendation",
          targetId: { in: recommendations.map((rec) => rec.id) },
        },
        select: { targetId: true, expiresAt: true },
      })
    : [];
  const approvalExpiry = new Map(
    pendingApprovals.map((p) => [p.targetId, p.expiresAt]),
  );
  return {
    decisions,
    /** `pendingApprovalExpiresAt` is set while a second-admin proposal is open. */
    recommendations: recommendations.map((rec) => ({
      ...rec,
      pendingApprovalExpiresAt: approvalExpiry.get(rec.id) ?? null,
    })),
    holds,
    evidenceRequests: requests,
    recipients,
    canManage: staff,
    canExecuteMoney: hasBackofficePermission(
      actor.role,
      "supportRefunds.executeBounded",
    ),
    canManageHolds: hasBackofficePermission(actor.role, "supportHolds.manage"),
    canVoidRecommendations: hasBackofficePermission(
      actor.role,
      "refunds.manage",
    ),
    /** Per-payment cumulative refund ceiling for this operator; null is unbounded. */
    refundLimitPaise:
      actor.role === "ADMIN" ? null : STAFF_REFUND_PER_PAYMENT_PAISE,
    planRefund:
      moneyRead && supportCase.appointmentId
        ? await casePlanRefund(supportCase, supportCase.appointmentId)
        : null,
    ownershipScope: supportCase.ownershipScope,
    updatedAt: supportCase.updatedAt,
    caseKind: supportCase.caseKind,
    isAppeal: Boolean(
      supportCase.appealOfDecisionId || supportCase.appealOfModerationActionId,
    ),
    /** A host's conduct removal is upheld or overturned, like an appeal. */
    reviewsRemoval: supportCase.category === CONDUCT_REMOVAL_CATEGORY,
    legalHoldAt: staff ? supportCase.legalHoldAt : null,
    /** Supersede and legal hold are admin-only. */
    isAdmin: actor.role === "ADMIN",
  };
}

/**
 * What a recommendation may still refund: the payment's refundable balance
 * less other approved support remedies on it that have no live refund yet,
 * plus what other refunds and remedies already committed on the payment and
 * any blocker.
 */
export async function quoteCaseRefund(
  tx: Tx,
  caseId: string,
  recommendation: { id: string; paymentId: string },
) {
  const payment = await linkedPayment(tx, caseId, recommendation.paymentId);
  const committed = await committedSupportPaiseByPayment(
    tx,
    [recommendation.paymentId],
    { excludeRecommendationId: recommendation.id },
  );
  const committedPaise = committed.get(recommendation.paymentId) ?? 0;
  const others = await tx.supportFinancialRecommendation.findMany({
    where: {
      paymentId: recommendation.paymentId,
      approved: true,
      id: { not: recommendation.id },
    },
    select: { amountPaise: true, refund: { select: { status: true } } },
  });
  const unrefundedPaise = others
    .filter((other) => !isLiveRefund(other.refund))
    .reduce((sum, other) => sum + Number(other.amountPaise), 0);
  let blocked: { code: string; reason: string } | null = null;
  if (payment.paymentStatus !== "SUCCEEDED")
    blocked = {
      code: "PAYMENT_NOT_SUCCEEDED",
      reason: "Payment is not captured",
    };
  else if (
    payment.disputes.some(
      (dispute) => !DISPUTE_INACTIVE_FOR_GATING.includes(dispute.status),
    )
  )
    blocked = {
      code: "REFUND_BLOCKED_BY_DISPUTE",
      reason: "A gateway chargeback is active",
    };
  return {
    refundablePaise: Math.max(
      0,
      refundableBalancePaise(Number(payment.amount), payment) - unrefundedPaise,
    ),
    committedPaise,
    rail: fundingRailForIntent(payment.paymentIntent),
    blocked,
  };
}

/**
 * What a remedy moves for the staff limits and the second-approver price: its
 * cash amount, or on a credit-funded payment the referral credit it restores.
 */
async function remedyValuePaise(
  db: Pick<Tx, "referralCreditUsage">,
  rail: FundingRail,
  recommendation: { paymentId: string; amountPaise: number | bigint },
): Promise<number> {
  return rail === "CREDITS"
    ? creditStillUsedPaise(db, recommendation.paymentId)
    : Number(recommendation.amountPaise);
}

/** The checks an approval or a retry must pass before any money moves. */
async function assertRefundExecutable(
  tx: Tx,
  caseId: string,
  actor: CaseActor,
  recommendation: {
    id: string;
    paymentId: string;
    amountPaise: number | bigint;
    proposedById: string;
  },
  expectedRefundablePaise: number | undefined,
) {
  const quote = await quoteCaseRefund(tx, caseId, recommendation);
  if (quote.blocked)
    throw new CaseActionError(quote.blocked.code, `${quote.blocked.reason}.`);
  if (expectedRefundablePaise !== quote.refundablePaise)
    throw new CaseActionError(
      "PREVIEW_CHANGED",
      "Refresh the refund preview before approving.",
    );
  const amountPaise = Number(recommendation.amountPaise);
  if (amountPaise > quote.refundablePaise)
    throw new CaseActionError(
      "AMOUNT_EXCEEDS_REFUNDABLE",
      "The recommendation exceeds the refundable balance.",
    );
  await assertNotOwnRemedy(tx, recommendation.proposedById, actor.userId);
  await assertBoundedRefund(tx, actor, [
    {
      paymentId: recommendation.paymentId,
      newPaise: await remedyValuePaise(tx, quote.rail, recommendation),
      priorPaise: quote.committedPaise,
    },
  ]);
}

/**
 * The amount the second-admin rule prices for a review: this remedy plus the
 * remedies already committed on its payment, or 0 when no new money moves.
 * Staff limits and blockers refuse here, before any proposal is opened.
 */
export async function priceCaseRefundReview(
  tx: Tx,
  caseId: string,
  actor: CaseActor,
  input: { recommendationId: string; approve: boolean },
): Promise<number> {
  const recommendation = await tx.supportFinancialRecommendation.findFirst({
    where: { id: input.recommendationId, caseId },
    include: { refund: { select: { status: true } } },
  });
  if (!recommendation)
    throw new CaseActionError("NOT_FOUND", "Recommendation not found.", 404);
  if (
    recommendation.decidedAt &&
    (recommendation.approved !== input.approve || recommendation.voidedAt)
  )
    throw new CaseActionError(
      "ALREADY_DECIDED",
      "This recommendation already has a decision.",
    );
  if (!input.approve || isLiveRefund(recommendation.refund)) return 0;
  const quote = await quoteCaseRefund(tx, caseId, recommendation);
  if (quote.blocked)
    throw new CaseActionError(quote.blocked.code, `${quote.blocked.reason}.`);
  const valuePaise = await remedyValuePaise(tx, quote.rail, recommendation);
  await assertBoundedRefund(tx, actor, [
    {
      paymentId: recommendation.paymentId,
      newPaise: valuePaise,
      priorPaise: quote.committedPaise,
    },
  ]);
  return valuePaise + quote.committedPaise;
}

type ActionInput<Action extends CaseAction["action"]> = Extract<
  CaseAction,
  { action: Action }
>;

function idempotencyKeyReused() {
  return new CaseActionError(
    "IDEMPOTENCY_KEY_REUSED",
    "This action was already submitted with different details.",
  );
}

/**
 * The stored row for a retried action. The same `clientActionId` with other
 * details, another actor or another action kind is refused, never replayed.
 */
async function replayCaseActionTx(
  tx: Tx,
  caseId: string,
  actor: CaseActor,
  input: CaseAction,
) {
  if (
    input.action !== "REQUEST_EVIDENCE" &&
    input.action !== "RECOMMEND_REFUND" &&
    input.action !== "DECIDE"
  )
    return null;
  const where = {
    caseId_clientActionId: { caseId, clientActionId: input.clientActionId },
  };
  const evidence = await tx.supportCaseEvidenceRequest.findUnique({ where });
  const recommendation = await tx.supportFinancialRecommendation.findUnique({
    where,
  });
  const decision = await tx.supportCaseDecision.findUnique({ where });
  if (!evidence && !recommendation && !decision) return null;
  if (input.action === "REQUEST_EVIDENCE") {
    if (
      evidence?.recipientUserId !== input.recipientUserId ||
      evidence.prompt !== input.prompt ||
      evidence.requestedById !== actor.userId
    )
      throw idempotencyKeyReused();
    return evidence;
  }
  if (input.action === "RECOMMEND_REFUND") {
    if (
      recommendation?.paymentId !== input.paymentId ||
      Number(recommendation.amountPaise) !== input.amountPaise ||
      recommendation.reason !== input.reason ||
      recommendation.releaseSeat !== input.releaseSeat ||
      recommendation.sessionsRemoved !== (input.sessions ?? null) ||
      recommendation.proposedById !== actor.userId
    )
      throw idempotencyKeyReused();
    return recommendation;
  }
  if (
    decision?.outcome !== input.outcome ||
    decision.explanation !== input.explanation ||
    decision.privateRationale !== (input.privateRationale ?? null) ||
    decision.supersedesDecisionId !== (input.supersedesDecisionId ?? null) ||
    decision.decidedById !== actor.userId
  )
    throw idempotencyKeyReused();
  return decision;
}

async function stageDecisionNotificationsTx(
  tx: Tx,
  supportCase: SupportCase,
  decision: SupportCaseDecision,
) {
  const caseId = supportCase.id;
  if (supportCase.externalRequesterEmail) {
    await stageExternalRequesterEmail(
      {
        caseId,
        reference: supportCase.referenceNumber,
        to: supportCase.externalRequesterEmail,
        subject: `Support decision — ${supportCase.referenceNumber}`,
        text: `Reference: ${supportCase.referenceNumber}\n\n${decision.explanation}`,
        emailType: "SUPPORT_TICKET_UPDATE",
        entityRef: `decision:${decision.id}`,
      },
      tx,
    );
  } else
    await stageCaseNotice(
      tx,
      supportCase,
      await caseCorrespondentIds(supportCase, tx),
      "A decision is ready",
      `decision:${decision.id}`,
    );
  const affectedRequests = await tx.supportCaseEvidenceRequest.findMany({
    where: { caseId, cancelledAt: null },
    distinct: ["recipientUserId"],
    select: { id: true, recipientUserId: true },
  });
  // Stage outbox rows sequentially on this transaction's single connection.
  for (const request of affectedRequests) {
    await stageBell(tx, {
      workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_UPDATE,
      recipients: [request.recipientUserId],
      dedupeKey: `decision:${decision.id}:${request.recipientUserId}`,
      entityRef: `decision:${decision.id}`,
      payload: {
        ticketId: request.id,
        ticketTitle: "Platform decision",
        status: "A decision is ready for independent review",
        dashboardUrl: `/dashboard/evidence/${request.id}`,
        ...notificationScope(null),
      },
    });
  }
}

/** A refund outcome must match the money: approved needs a live refund, declined none approved. */
async function assertDecisionMatchesMoney(
  tx: Tx,
  caseId: string,
  outcome: ActionInput<"DECIDE">["outcome"],
) {
  if (outcome === "REFUND_APPROVED") {
    const live = await tx.supportFinancialRecommendation.findFirst({
      where: {
        caseId,
        approved: true,
        refund: { status: { in: ["PENDING", "SUCCEEDED"] } },
      },
      select: { id: true },
    });
    if (!live)
      throw new CaseActionError(
        "REFUND_NOT_LIVE",
        "Record a refund approval once an approved refund is pending or sent.",
      );
  }
  if (outcome === "REFUND_DECLINED") {
    const approved = await tx.supportFinancialRecommendation.findFirst({
      where: { caseId, approved: true },
      select: { id: true },
    });
    if (approved)
      throw new CaseActionError(
        "REFUND_APPROVED_EXISTS",
        "This case has an approved refund. Void it before recording a decline.",
      );
  }
}

/** Deciding releases the case's payout holds, so every recommendation must be reviewed or voided first. */
async function assertNoOpenRecommendation(tx: Tx, caseId: string) {
  const open = await tx.supportFinancialRecommendation.findFirst({
    where: { caseId, decidedAt: null, voidedAt: null },
    select: { id: true },
  });
  if (open)
    throw new CaseActionError(
      "RECOMMENDATION_OPEN",
      "This case has a refund recommendation awaiting review. Review or void it before recording a decision.",
    );
}

/** A decision released the case's holds; only a failed refund under REFUND_APPROVED may still be retried. */
async function assertUndecidedForApproval(
  tx: Tx,
  caseId: string,
  retry: boolean,
) {
  const decision = await latestCaseDecisionTx(tx, caseId);
  if (!decision || (retry && decision.outcome === "REFUND_APPROVED")) return;
  throw new CaseActionError(
    "CASE_ALREADY_DECIDED",
    "This case already has a decision, so its refund recommendations can only be declined.",
    409,
    caseDecidedDetail(decision),
  );
}

const APPEAL_OUTCOMES: ReadonlySet<string> = new Set(["UPHELD", "OVERTURNED"]);

/** Problems are resolved, not decided; appeals and conduct removals are upheld or overturned; incidents get a remedy outcome. */
function assertDecisionFitsCase(
  supportCase: SupportCase,
  outcome: ActionInput<"DECIDE">["outcome"],
) {
  if (supportCase.caseKind === "PROBLEM")
    throw new CaseActionError(
      "DECISION_NOT_ALLOWED",
      "A problem record is resolved, not decided. Record decisions on its linked incidents.",
      400,
    );
  if (supportCase.status === "CLOSED")
    throw new CaseActionError(
      "CASE_CLOSED",
      "This case is closed, so a decision can no longer be recorded.",
    );
  const appeal = Boolean(
    supportCase.appealOfDecisionId || supportCase.appealOfModerationActionId,
  );
  const removal = supportCase.category === CONDUCT_REMOVAL_CATEGORY;
  if ((appeal || removal) !== APPEAL_OUTCOMES.has(outcome))
    throw new CaseActionError(
      "OUTCOME_NOT_ALLOWED",
      appeal || removal
        ? "An appeal or a conduct removal is decided as upheld or overturned."
        : "Upheld and overturned apply only to appeals and conduct removals.",
      400,
    );
}

async function reverseModerationIfOverturned(
  tx: Tx,
  supportCase: SupportCase,
  actor: CaseActor,
  input: ActionInput<"DECIDE">,
): Promise<string | undefined> {
  if (input.outcome !== "OVERTURNED" || !supportCase.appealOfModerationActionId)
    return undefined;
  const reversal = await reverseAppealedModeration(
    tx,
    supportCase.appealOfModerationActionId,
    actor,
    input.explanation,
  );
  if (!reversal.ok)
    throw new CaseActionError("COMPENSATING_ACTION_REQUIRED", reversal.error);
  return reversal.consultantProfileId;
}

async function recordCaseDecisionTx(
  tx: Tx,
  supportCase: SupportCase,
  actor: CaseActor,
  input: ActionInput<"DECIDE">,
) {
  const caseId = supportCase.id;
  assertDecisionFitsCase(supportCase, input.outcome);
  const latest = await latestCaseDecisionTx(tx, caseId);
  if (input.supersedesDecisionId)
    return supersedeDecisionTx(tx, supportCase, actor, input, latest);
  if (latest)
    throw new CaseActionError(
      "CASE_ALREADY_DECIDED",
      "This case already has a decision. An admin can supersede it while its appeal window is open.",
      409,
      caseDecidedDetail(latest),
    );
  await assertDecisionMatchesMoney(tx, caseId, input.outcome);
  await assertNoOpenRecommendation(tx, caseId);
  const restoredConsultantProfileId = await reverseModerationIfOverturned(
    tx,
    supportCase,
    actor,
    input,
  );
  const moved = await executePatchLifecycleTx(
    tx,
    {
      caseId,
      actorId: actor.userId,
      expectedUpdatedAt: input.expectedUpdatedAt,
      status: "RESOLVED",
    },
    new Date(),
    { actorRole: actor.role ?? "UNKNOWN", freshSession: !!actor.freshSession },
  );
  if (!moved.ok)
    throw new CaseActionError(moved.code, moved.error, moved.status);
  const decision = await tx.supportCaseDecision.create({
    data: {
      caseId,
      decidedById: actor.userId,
      clientActionId: input.clientActionId,
      outcome: input.outcome,
      explanation: input.explanation,
      privateRationale: input.privateRationale,
      appealUntil: new Date(Date.now() + 7 * 86_400_000),
    },
  });
  await caseEvent(
    tx,
    caseId,
    actor.userId,
    "DECISION_RECORDED",
    decision.id,
    input.outcome,
  );
  await stageDecisionNotificationsTx(tx, supportCase, decision);
  await conductRemovalDecidedTx(tx, supportCase, input.outcome);
  return { ...decision, restoredConsultantProfileId };
}

/** A correction may not orphan what the decision in force already did: a reversed moderation action or a live refund. */
async function assertSupersedeKeepsEffects(
  tx: Tx,
  supportCase: SupportCase,
  latest: SupportCaseDecision,
  outcome: ActionInput<"DECIDE">["outcome"],
) {
  // Reinstating a reversed moderation action is not automated.
  if (
    latest.outcome === "OVERTURNED" &&
    outcome !== "OVERTURNED" &&
    supportCase.appealOfModerationActionId
  )
    throw new CaseActionError(
      "COMPENSATING_ACTION_REQUIRED",
      "The moderation action was already reversed. Reinstate it from moderation first.",
    );
  // An overturned removal already owes its refund and its unblock.
  if (
    latest.outcome === "OVERTURNED" &&
    outcome !== "OVERTURNED" &&
    (await reviewedRemovalCaseId(tx, supportCase))
  )
    throw new CaseActionError(
      "COMPENSATING_ACTION_REQUIRED",
      "The removal was overturned, so its refund and unblock are already owed. It cannot be upheld again.",
    );
  if (latest.outcome !== "REFUND_APPROVED" || outcome === "REFUND_APPROVED")
    return;
  const live = await tx.supportFinancialRecommendation.findFirst({
    where: {
      caseId: supportCase.id,
      approved: true,
      refund: { status: { in: ["PENDING", "SUCCEEDED"] } },
    },
    select: { id: true },
  });
  if (live)
    throw new CaseActionError(
      "REFUND_APPROVED_EXISTS",
      "A refund under this decision is pending or sent. Void or reconcile it before superseding.",
    );
}

/**
 * An admin correction of the decision in force, while its appeal window is
 * open and before anyone appeals. It keeps the original appeal deadline and
 * leaves the resolution time, and so the auto-close and CSAT prompt, alone.
 */
async function supersedeDecisionTx(
  tx: Tx,
  supportCase: SupportCase,
  actor: CaseActor,
  input: ActionInput<"DECIDE">,
  latest: SupportCaseDecision | null,
) {
  const caseId = supportCase.id;
  if (actor.role !== "ADMIN")
    throw new CaseActionError(
      "FORBIDDEN",
      "Only an admin can supersede a decision.",
      403,
    );
  if (!latest || latest.id !== input.supersedesDecisionId)
    throw new CaseActionError(
      "DECISION_SUPERSEDED",
      "That is not the decision in force on this case. Refresh and try again.",
      409,
      latest ? caseDecidedDetail(latest) : {},
    );
  if (Date.now() > latest.appealUntil.getTime())
    throw new CaseActionError(
      "SUPERSEDE_WINDOW_CLOSED",
      "The appeal window for this decision has ended, so it can no longer be superseded.",
    );
  const appealed = await tx.supportCaseDecision.findFirst({
    where: { caseId, appeals: { some: {} } },
    select: { id: true },
  });
  if (appealed)
    throw new CaseActionError(
      "DECISION_APPEALED",
      "This decision has been appealed. Record the outcome on the appeal instead.",
    );
  await assertSupersedeKeepsEffects(tx, supportCase, latest, input.outcome);
  await assertDecisionMatchesMoney(tx, caseId, input.outcome);
  const restoredConsultantProfileId =
    latest.outcome === "OVERTURNED"
      ? undefined
      : await reverseModerationIfOverturned(tx, supportCase, actor, input);
  await touchCase(tx, caseId, input.expectedUpdatedAt);
  const decision = await tx.supportCaseDecision.create({
    data: {
      caseId,
      decidedById: actor.userId,
      clientActionId: input.clientActionId,
      outcome: input.outcome,
      explanation: input.explanation,
      privateRationale: input.privateRationale,
      appealUntil: latest.appealUntil,
      supersedesDecisionId: latest.id,
    },
  });
  await tx.supportCaseEvent.create({
    data: {
      caseId,
      actorId: actor.userId,
      kind: "DECISION_RECORDED",
      fromValue: latest.id,
      toValue: decision.id,
      note: input.outcome,
      createdAt: new Date(),
    },
  });
  await stageDecisionNotificationsTx(tx, supportCase, decision);
  if (latest.outcome !== "OVERTURNED")
    await conductRemovalDecidedTx(tx, supportCase, input.outcome);
  return { ...decision, restoredConsultantProfileId };
}

async function requestEvidenceTx(
  tx: Tx,
  supportCase: SupportCase,
  actor: CaseActor,
  input: ActionInput<"REQUEST_EVIDENCE">,
) {
  const caseId = supportCase.id;
  const recipients = await evidenceRecipients(tx, supportCase.appointmentId);
  if (!recipients.some((p) => p.id === input.recipientUserId))
    throw new CaseActionError(
      "INVALID_RECIPIENT",
      "Choose a delivery participant or authorized host representative.",
      400,
    );
  const dueAt = new Date(
    Math.min(
      input.dueAt
        ? new Date(input.dueAt).getTime()
        : Date.now() + 48 * 3_600_000,
      supportCase.statutoryDueAt?.getTime() ?? Infinity,
    ),
  );
  if (dueAt <= new Date())
    throw new CaseActionError(
      "DEADLINE_PASSED",
      "This case needs immediate review; its evidence deadline has passed.",
    );
  const request = await tx.supportCaseEvidenceRequest.create({
    data: {
      caseId,
      recipientUserId: input.recipientUserId,
      requestedById: actor.userId,
      clientActionId: input.clientActionId,
      prompt: input.prompt,
      dueAt,
    },
  });
  await caseEvent(tx, caseId, actor.userId, "EVIDENCE_REQUESTED", request.id);
  await stageBell(tx, {
    workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_UPDATE,
    recipients: [input.recipientUserId],
    dedupeKey: `evidence-request:${request.id}`,
    entityRef: `evidence-request:${request.id}`,
    payload: {
      ticketId: request.id,
      ticketTitle: "Evidence request",
      status: "Please respond to an evidence request",
      dashboardUrl: `/dashboard/evidence/${request.id}`,
      ...notificationScope(null),
    },
  });
  return request;
}

async function cancelEvidenceTx(
  tx: Tx,
  caseId: string,
  actor: CaseActor,
  input: ActionInput<"CANCEL_EVIDENCE">,
) {
  const cancelled = await tx.supportCaseEvidenceRequest.updateMany({
    where: {
      id: input.requestId,
      caseId,
      respondedAt: null,
      cancelledAt: null,
    },
    data: { cancelledAt: new Date() },
  });
  if (!cancelled.count)
    throw new CaseActionError(
      "CONFLICT",
      "Evidence was already submitted or cancelled.",
    );
  await caseEvent(
    tx,
    caseId,
    actor.userId,
    "EVIDENCE_CANCELLED",
    input.requestId,
    input.reason,
  );
  return { ok: true };
}

async function recommendRefundTx(
  tx: Tx,
  caseId: string,
  actor: CaseActor,
  input: ActionInput<"RECOMMEND_REFUND">,
) {
  const linked = await linkedPayment(tx, caseId, input.paymentId);
  const creditFunded = linked.paymentIntent.startsWith("free_");
  if (
    (creditFunded && input.amountPaise !== 0) ||
    (!creditFunded && input.amountPaise <= 0)
  )
    throw new CaseActionError(
      "INVALID_AMOUNT",
      creditFunded
        ? "Request a full credit restoration with zero cash amount."
        : "Enter a positive refund amount.",
      400,
    );
  const open = await tx.supportFinancialRecommendation.findFirst({
    where: { paymentId: input.paymentId, decidedAt: null },
    select: { id: true },
  });
  if (open) throw openRecommendationError();
  if (input.sessions !== undefined)
    await assertSessionShare(
      tx,
      caseId,
      linked,
      input.amountPaise,
      input.sessions,
    );
  const recommendation = await tx.supportFinancialRecommendation.create({
    data: {
      caseId,
      paymentId: input.paymentId,
      proposedById: actor.userId,
      clientActionId: input.clientActionId,
      amountPaise: input.amountPaise,
      reason: input.reason,
      releaseSeat: input.releaseSeat,
      sessionsRemoved: input.sessions ?? null,
    },
  });
  await caseEvent(
    tx,
    caseId,
    actor.userId,
    "RECOMMENDATION_PROPOSED",
    recommendation.id,
  );
  return recommendation;
}

/**
 * A session-count remedy refunds exactly those sessions' share of the plan,
 * capped at the refundable balance, and only sessions not yet held.
 */
async function assertSessionShare(
  tx: Tx,
  caseId: string,
  payment: { id: string; amount: number | bigint; paymentIntent: string },
  amountPaise: number,
  sessions: number,
) {
  if (payment.paymentIntent.startsWith("free_"))
    throw new CaseActionError(
      "INVALID_SESSIONS",
      "A plan paid with credits returns its credits in full. Recommend it without a session count.",
      400,
    );
  const basis = await planRefundBasis(tx, payment.id);
  if (!basis)
    throw new CaseActionError(
      "INVALID_SESSIONS",
      "Session counts apply to plan payments only.",
      400,
    );
  if (!basis.open) throw planClosedError();
  if (sessions > basis.removable)
    throw new CaseActionError(
      "SESSIONS_EXCEED_PLAN",
      `Only ${basis.removable} session${basis.removable === 1 ? "" : "s"} on this plan ${basis.removable === 1 ? "is" : "are"} not booked or delivered yet. Cancel booked sessions first to remove more.`,
    );
  const quote = await quoteCaseRefund(tx, caseId, {
    id: "",
    paymentId: payment.id,
  });
  const share = Math.min(
    sessionShareOf(Number(payment.amount), sessions, basis.sessionsTotal),
    quote.refundablePaise,
  );
  if (amountPaise !== share)
    throw new CaseActionError(
      "PREVIEW_CHANGED",
      "The plan or its refundable balance changed. Refresh and enter the sessions again.",
    );
}

/** A cancelled, ended or settling plan is paid by its own settlement, not by a session count. */
function planClosedError() {
  return new CaseActionError(
    "INVALID_SESSIONS",
    "This plan has ended, been cancelled or is settling. Refund by amount if anything is still owed.",
    400,
  );
}

/** The CAS on the plan's removed-session count lost, or the plan moved under the remedy. */
function planSessionsError(change: Exclude<PlanSessionsChange, { ok: true }>) {
  if (change.reason === "PLAN_CLOSED") return planClosedError();
  if (change.reason === "PLAN_SETTLED")
    return new CaseActionError(
      "NOT_VOIDABLE",
      "This plan settled without these sessions, so their refund is still owed. Retry it instead of voiding it.",
    );
  if (change.reason === "NOT_REMOVED")
    return new CaseActionError(
      "CONFLICT",
      "The plan has fewer removed sessions than this refund took off. Ask engineering to check it before voiding.",
    );
  if (change.reason === "EXCEEDS_REMOVABLE")
    return new CaseActionError(
      "SESSIONS_EXCEED_PLAN",
      `The plan changed: only ${change.removable} session${change.removable === 1 ? "" : "s"} can still be removed. Decline this recommendation and recommend again.`,
    );
  return new CaseActionError(
    "CONFLICT",
    "The plan changed while you were reviewing. Refresh and try again.",
  );
}

/** The approval takes a session-count remedy's sessions off the plan in the same commit. */
async function removeApprovedSessions(
  tx: Tx,
  recommendation: { paymentId: string; sessionsRemoved: number | null },
) {
  if (!recommendation.sessionsRemoved) return;
  const change = await removePlanSessions(
    tx,
    recommendation.paymentId,
    recommendation.sessionsRemoved,
  );
  if (!change.ok) throw planSessionsError(change);
}

function openRecommendationError() {
  return new CaseActionError(
    "RECOMMENDATION_OPEN",
    "This payment already has a refund recommendation awaiting review.",
  );
}

/**
 * Claims the decision on a recommendation. It is guarded by the
 * recommendation's own `decidedAt` CAS and the previewed refundable balance,
 * not by the case version, so a second-admin replay survives case activity.
 * An approved recommendation whose refund failed or never started may be
 * retried through the same checks.
 */
async function reviewRefundTx(
  tx: Tx,
  caseId: string,
  actor: CaseActor,
  input: ActionInput<"REVIEW_REFUND">,
) {
  const recommendation = await tx.supportFinancialRecommendation.findFirst({
    where: { id: input.recommendationId, caseId },
    include: { refund: { select: { id: true, status: true } } },
  });
  if (!recommendation)
    throw new CaseActionError("NOT_FOUND", "Recommendation not found.", 404);
  if (recommendation.decidedAt) {
    if (recommendation.approved !== input.approve || recommendation.voidedAt)
      throw new CaseActionError(
        "ALREADY_DECIDED",
        "This recommendation already has a decision.",
      );
    // A serializable retry of a lost claim lands here; only the decider may retry the refund.
    if (recommendation.decidedById !== actor.userId)
      throw new CaseActionError(
        "CONFLICT",
        "Another administrator reviewed this recommendation.",
      );
    if (input.approve && !isLiveRefund(recommendation.refund)) {
      await assertUndecidedForApproval(tx, caseId, true);
      await claimRefundRetry(tx, caseId, actor, recommendation, input);
    }
    return recommendation;
  }
  if (input.approve) {
    await assertUndecidedForApproval(tx, caseId, false);
    await assertRefundExecutable(
      tx,
      caseId,
      actor,
      recommendation,
      input.expectedRefundablePaise,
    );
  }
  const decidedAt = new Date();
  const claimed = await tx.supportFinancialRecommendation.updateMany({
    where: { id: recommendation.id, decidedAt: null },
    data: {
      decidedAt,
      decidedById: actor.userId,
      approved: input.approve,
      decisionReason: input.reason,
    },
  });
  if (!claimed.count)
    throw new CaseActionError(
      "CONFLICT",
      "Another administrator reviewed this recommendation.",
    );
  if (input.approve) await removeApprovedSessions(tx, recommendation);
  await caseEvent(
    tx,
    caseId,
    actor.userId,
    "RECOMMENDATION_DECIDED",
    recommendation.id,
    input.approve ? "APPROVED" : "DECLINED",
  );
  return {
    ...recommendation,
    decidedAt,
    decidedById: actor.userId,
    approved: input.approve,
    decisionReason: input.reason,
  };
}

/**
 * A retry of an approval whose refund failed or never started. It locks the
 * row against a concurrent void and leaves a RETRIED event the void honours
 * for the send grace, since the refund itself is sent after this commits.
 */
async function claimRefundRetry(
  tx: Tx,
  caseId: string,
  actor: CaseActor,
  recommendation: {
    id: string;
    paymentId: string;
    amountPaise: number | bigint;
    proposedById: string;
  },
  input: ActionInput<"REVIEW_REFUND">,
) {
  await assertRefundExecutable(
    tx,
    caseId,
    actor,
    recommendation,
    input.expectedRefundablePaise,
  );
  const claimed = await tx.supportFinancialRecommendation.updateMany({
    where: { id: recommendation.id, approved: true, voidedAt: null },
    data: { decisionReason: input.reason },
  });
  if (!claimed.count)
    throw new CaseActionError(
      "ALREADY_DECIDED",
      "This recommendation was voided; it cannot be retried.",
    );
  await caseEvent(
    tx,
    caseId,
    actor.userId,
    "RECOMMENDATION_DECIDED",
    recommendation.id,
    RETRIED,
  );
}

const RETRIED = "RETRIED";

/** Withdraws an approval whose refund never went live, so the case can move on. */
async function voidRecommendationTx(
  tx: Tx,
  caseId: string,
  actor: CaseActor,
  input: ActionInput<"VOID_RECOMMENDATION">,
) {
  const voidedAt = new Date();
  const graceStart = new Date(
    voidedAt.getTime() - SUPPORT_REFUND_SEND_GRACE_MS,
  );
  // The CAS takes the row lock first, so a concurrent retry either commits
  // before the checks below read it or finds the row voided.
  const voided = await tx.supportFinancialRecommendation.updateMany({
    where: {
      id: input.recommendationId,
      caseId,
      approved: true,
      voidedAt: null,
      OR: [
        { refundId: null, decidedAt: { lte: graceStart } },
        { refund: { status: { in: ["FAILED", "CANCELLED"] } } },
      ],
    },
    data: { approved: false, voidedAt, voidedById: actor.userId },
  });
  if (voided.count) {
    const sending = await tx.refund.findFirst({
      where: {
        dedupeKey: `case-recommendation:${input.recommendationId}`,
        status: { in: ["PENDING", "SUCCEEDED"] },
      },
      select: { id: true },
    });
    const retried = await tx.supportCaseEvent.findFirst({
      where: {
        caseId,
        kind: "RECOMMENDATION_DECIDED",
        toValue: input.recommendationId,
        note: RETRIED,
        createdAt: { gte: graceStart },
      },
      select: { id: true },
    });
    if (sending || retried)
      throw new CaseActionError(
        "NOT_VOIDABLE",
        "A refund for this recommendation is pending, sent or being retried; it cannot be voided.",
      );
  }
  const recommendation = await tx.supportFinancialRecommendation.findFirst({
    where: { id: input.recommendationId, caseId },
  });
  if (!recommendation)
    throw new CaseActionError("NOT_FOUND", "Recommendation not found.", 404);
  if (!voided.count) {
    if (recommendation.voidedAt) return recommendation;
    throw new CaseActionError(
      "NOT_VOIDABLE",
      "Only an approved recommendation whose refund failed, or never started within 15 minutes, can be voided.",
    );
  }
  // The refund never went out, so the sessions it removed go back on the plan.
  if (recommendation.sessionsRemoved) {
    const change = await restorePlanSessions(
      tx,
      recommendation.paymentId,
      recommendation.sessionsRemoved,
    );
    if (!change.ok) throw planSessionsError(change);
  }
  await caseEvent(
    tx,
    caseId,
    actor.userId,
    "RECOMMENDATION_VOIDED",
    recommendation.id,
    input.reason,
  );
  return recommendation;
}

async function touchCase(tx: Tx, caseId: string, expectedUpdatedAt: string) {
  const touched = await tx.supportCase.updateMany({
    where: { id: caseId, updatedAt: new Date(expectedUpdatedAt) },
    data: { updatedAt: new Date() },
  });
  if (touched.count !== 1)
    throw new CaseActionError(
      "CONFLICT",
      "This case changed. Refresh before continuing.",
    );
}

async function applyHoldTx(
  tx: Tx,
  caseId: string,
  actor: CaseActor,
  input: ActionInput<"APPLY_HOLD">,
) {
  await linkedPayment(tx, caseId, input.paymentId);
  const [active] = activeHolds(
    await caseHoldEvents(tx, [caseId], input.paymentId),
  );
  if (active)
    return {
      holdId: active.id,
      paymentId: input.paymentId,
      replayed: true,
      consultantEarningIds: [],
      orgEarningIds: [],
      cancelledPayoutIds: [],
    };
  await touchCase(tx, caseId, input.expectedUpdatedAt);
  const held = await holdPaymentForCase(tx, {
    caseId,
    paymentId: input.paymentId,
    note: input.reason,
  });
  const event = await tx.supportCaseEvent.create({
    data: {
      caseId,
      actorId: actor.userId,
      kind: "HOLD_APPLIED",
      toValue: input.paymentId,
      note: input.reason,
      createdAt: new Date(),
    },
  });
  return {
    holdId: event.id,
    paymentId: input.paymentId,
    replayed: false,
    ...held,
  };
}

async function releaseHoldTx(
  tx: Tx,
  caseId: string,
  actor: CaseActor,
  input: ActionInput<"RELEASE_HOLD">,
) {
  const applied = await tx.supportCaseEvent.findFirst({
    where: { id: input.holdId, caseId, kind: "HOLD_APPLIED" },
    select: { id: true, toValue: true },
  });
  if (!applied?.toValue)
    throw new CaseActionError("NOT_FOUND", "Hold not found.", 404);
  const paymentId = applied.toValue;
  const [active] = activeHolds(await caseHoldEvents(tx, [caseId], paymentId));
  if (active?.id !== applied.id)
    return {
      holdId: applied.id,
      paymentId,
      replayed: true,
      consultantEarningIds: [],
      orgEarningIds: [],
    };
  await touchCase(tx, caseId, input.expectedUpdatedAt);
  const released = await releaseCaseHoldRows(tx, {
    caseId,
    paymentId,
    releasedById: actor.userId,
  });
  await tx.supportCaseEvent.create({
    data: {
      caseId,
      actorId: actor.userId,
      kind: "HOLD_RELEASED",
      fromValue: applied.id,
      toValue: paymentId,
      note: input.reason,
      createdAt: new Date(),
    },
  });
  return { holdId: applied.id, paymentId, replayed: false, ...released };
}

/** Loads the live case and refuses an operator who cannot act on it. */
async function actionableCase(tx: Tx, caseId: string, actor: CaseActor) {
  const supportCase = await tx.supportCase.findFirst({
    where: { id: caseId, deletedAt: null },
  });
  if (!supportCase || !(await canCorrespondOnCase(supportCase, actor, tx)))
    throw new CaseActionError("NOT_FOUND", "Support case not found.", 404);
  if (supportCase.appealOfDecisionId || supportCase.appealOfModerationActionId)
    await assertIndependentReviewer(tx, supportCase, actor.userId);
  return supportCase;
}

/** Runs one case action on the caller's transaction; the door or wrapper owns the role check. */
export async function performCaseActionTx(
  tx: Tx,
  caseId: string,
  actor: CaseActor,
  input: CaseAction,
) {
  const supportCase = await actionableCase(tx, caseId, actor);
  const replay = await replayCaseActionTx(tx, caseId, actor, input);
  if (replay) return replay;
  switch (input.action) {
    case "DECIDE":
      return recordCaseDecisionTx(tx, supportCase, actor, input);
    case "REVIEW_REFUND":
      return reviewRefundTx(tx, caseId, actor, input);
    case "VOID_RECOMMENDATION":
      return voidRecommendationTx(tx, caseId, actor, input);
    case "APPLY_HOLD":
      return applyHoldTx(tx, caseId, actor, input);
    case "RELEASE_HOLD":
      return releaseHoldTx(tx, caseId, actor, input);
    case "REQUEST_EVIDENCE":
      await touchCase(tx, caseId, input.expectedUpdatedAt);
      return requestEvidenceTx(tx, supportCase, actor, input);
    case "RECOMMEND_REFUND":
      await touchCase(tx, caseId, input.expectedUpdatedAt);
      return recommendRefundTx(tx, caseId, actor, input);
    case "CANCEL_EVIDENCE":
      await touchCase(tx, caseId, input.expectedUpdatedAt);
      return cancelEvidenceTx(tx, caseId, actor, input);
  }
}

/** The back-office surface each action needs; the doors enforce money limits on top. */
export function caseActionSurface(input: CaseAction): BackofficeSurface {
  switch (input.action) {
    case "REVIEW_REFUND":
      return "supportRefunds.executeBounded";
    case "VOID_RECOMMENDATION":
      return "refunds.manage";
    case "APPLY_HOLD":
    case "RELEASE_HOLD":
      return "supportHolds.manage";
    case "DECIDE":
      return input.outcome === "REFUND_APPROVED" ||
        input.outcome === "REFUND_DECLINED"
        ? "supportRefunds.executeBounded"
        : "tickets.manage";
    default:
      return "tickets.manage";
  }
}

export async function performCaseAction(
  caseId: string,
  actor: CaseActor,
  input: CaseAction,
) {
  if (!hasBackofficePermission(actor.role, caseActionSurface(input)))
    throw new CaseActionError(
      "FORBIDDEN",
      "This action is not available to your role.",
      403,
    );
  const result = await withSerializableRetry(() =>
    prisma.$transaction((tx) => performCaseActionTx(tx, caseId, actor, input), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    }),
  ).catch(async (error: unknown) => {
    if (!isUniqueViolation(error)) throw error;
    // A double submit lost the race on its own clientActionId: answer with the winner.
    const replay = await prisma.$transaction((tx) =>
      replayCaseActionTx(tx, caseId, actor, input),
    );
    if (replay) return replay;
    if (input.action === "RECOMMEND_REFUND") throw openRecommendationError();
    if (input.action === "DECIDE")
      throw new CaseActionError(
        "CASE_ALREADY_DECIDED",
        "Another decision was recorded on this case at the same time. Refresh to see it.",
      );
    throw error;
  });
  if (input.action === "DECIDE" && input.outcome === "OVERTURNED") {
    await settleDecidedRemoval(caseId);
    purgeReviewSurfaces(
      "restoredConsultantProfileId" in result &&
        typeof result.restoredConsultantProfileId === "string"
        ? result.restoredConsultantProfileId
        : undefined,
    );
  }
  if (input.action === "REVIEW_REFUND" && input.approve)
    return {
      ...result,
      ...(await executeApprovedRefund(caseId, actor, input)),
    };
  return result;
}

/**
 * Sends the approved remedy after the decision committed, keyed on the
 * recommendation so a retry resumes the same refund. `movedPaise` is the new
 * money or restored credit this call sent, which the staff rolling limit sums.
 */
async function executeApprovedRefund(
  caseId: string,
  actor: CaseActor,
  input: ActionInput<"REVIEW_REFUND">,
) {
  const recommendation =
    await prisma.supportFinancialRecommendation.findFirstOrThrow({
      where: { id: input.recommendationId, caseId, approved: true },
      include: {
        refund: { select: { status: true } },
        payment: { select: { paymentIntent: true } },
        supportCase: { select: { referenceNumber: true } },
      },
    });
  const wasLive = isLiveRefund(recommendation.refund);
  const rail = fundingRailForIntent(recommendation.payment.paymentIntent);
  // Read before the restoration, which gives the consumed credit back.
  const movedPaise = wasLive
    ? 0
    : await remedyValuePaise(prisma, rail, recommendation);
  const dedupeKey = `case-recommendation:${recommendation.id}`;
  const refund = await refundBookingPayment({
    paymentId: recommendation.paymentId,
    ...(rail === "CREDITS"
      ? {}
      : { amountPaise: Number(recommendation.amountPaise) }),
    reason: `Support remedy ${recommendation.supportCase.referenceNumber}`,
    initiatedByUserId: actor.userId,
    dedupeKey,
    supportRecommendationId: recommendation.id,
    keepSeat: !recommendation.releaseSeat,
    settlesOwedByHand: true,
  }).catch((error: unknown) => refundInFlightOr(error, dedupeKey));
  return { refund, movedPaise };
}
