import {
  Prisma,
  type SupportCase,
  type SupportCaseDecision,
  type UserRole,
} from "@prisma/client";
import { stage as stageEmail } from "@/lib/email/deliver";
import { DEFAULT_FROM_ADDRESS } from "@/lib/email/config";
import { z } from "zod";
import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { canCorrespondOnCase, caseCorrespondentIds } from "./case-access";
import { reverseAppealedModeration } from "./appeal-reversal";
import { purgeReviewSurfaces } from "@/lib/data/public-cache";
import { executePatchLifecycleTx } from "./case-service";
import { stageBell } from "@/lib/novu/stage-bell";
import { NOVU_WORKFLOWS, notificationScope } from "@/lib/novu/workflows";
import { supportRequestHref } from "@/lib/novu/resolve-href";
import { caseKeyOf } from "./case-key";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import { refundInFlightOr } from "@/lib/backoffice/refund-doors";
import { CaseRefundReviewSchema } from "@/schemas/support-refund-review";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";

const id = z.string().min(1).max(128);
const reason = z.string().trim().min(1).max(10_000);
const base = z.object({
  clientActionId: id,
  expectedUpdatedAt: z.string().datetime(),
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
  }),
  base.extend({
    action: z.literal("RECOMMEND_REFUND"),
    paymentId: id,
    amountPaise: z.number().int().nonnegative().safe(),
    reason,
  }),
  CaseRefundReviewSchema,
  base.extend({ action: z.literal("APPLY_HOLD"), paymentId: id, reason }),
  base.extend({ action: z.literal("RELEASE_HOLD"), holdId: id, reason }),
  base.extend({ action: z.literal("HANDOVER"), reason }),
]);
export type CaseAction = z.infer<typeof CaseActionSchema>;
export type CaseActor = { userId: string; role: UserRole | null };

export class CaseActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
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

async function privateEvent(
  tx: Tx,
  caseId: string,
  actorId: string,
  note: string,
) {
  await tx.supportCaseEvent.create({
    data: { caseId, actorId, kind: "VISIBILITY_CHANGED", note },
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

export async function evidenceRecipients(tx: Tx, appointmentId: string | null) {
  if (!appointmentId) return [];
  const plan = { consultantProfileId: true } as const;
  const groupPlan = {
    ...plan,
    collaborators: {
      where: { status: "ACCEPTED" as const },
      select: { consultantProfileId: true },
    },
  };
  const booking = await tx.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      participants: {
        where: {
          role: { in: ["CONSULTANT", "COLLABORATOR"] },
          status: { in: ["CONFIRMED", "ATTENDED"] },
        },
        select: { userId: true },
      },
      consultation: { select: { consultationPlan: { select: plan } } },
      subscription: { select: { subscriptionPlan: { select: plan } } },
      webinar: { select: { webinarPlan: { select: groupPlan } } },
      class: { select: { classPlan: { select: groupPlan } } },
      payment: { select: { hostOrganizationId: true } },
    },
  });
  if (!booking) return [];
  const people = new Set(booking.participants.map((p) => p.userId));
  const profileIds = [
    booking.consultation?.consultationPlan.consultantProfileId,
    booking.subscription?.subscriptionPlan.consultantProfileId,
    booking.webinar?.webinarPlan.consultantProfileId,
    booking.class?.classPlan.consultantProfileId,
    ...(booking.webinar?.webinarPlan.collaborators ?? []).map(
      (c) => c.consultantProfileId,
    ),
    ...(booking.class?.classPlan.collaborators ?? []).map(
      (c) => c.consultantProfileId,
    ),
  ].filter((profileId): profileId is string => Boolean(profileId));
  const profiles = await tx.consultantProfile.findMany({
    where: { id: { in: profileIds }, deletedAt: null },
    select: { user: { select: { id: true } } },
  });
  profiles.forEach((profile) => {
    if (profile.user) people.add(profile.user.id);
  });
  const hostIds = booking.payment.flatMap((p) =>
    p.hostOrganizationId ? [p.hostOrganizationId] : [],
  );
  if (hostIds.length) {
    const operators = await tx.membership.findMany({
      where: {
        organizationId: { in: hostIds },
        status: "ACTIVE",
        role: { in: ["OWNER", "MAINTAINER", "MANAGER", "SUPPORT"] },
      },
      select: { userId: true },
    });
    operators.forEach((m) => people.add(m.userId));
  }
  return tx.user.findMany({
    where: { id: { in: [...people] }, banned: { not: true } },
    select: { id: true, name: true },
  });
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
        moneyRead
          ? tx.supportPaymentHold.findMany({
              where: { caseId },
              orderBy: { createdAt: "desc" },
            })
          : [],
        staff
          ? tx.supportCaseEvidenceRequest.findMany({
              where: { caseId },
              orderBy: { createdAt: "desc" },
            })
          : [],
        staff ? evidenceRecipients(tx, supportCase.appointmentId) : [],
      ]),
    );
  return {
    decisions,
    recommendations,
    holds,
    evidenceRequests: requests,
    recipients,
    canManage: staff,
    canExecuteMoney: hasBackofficePermission(actor.role, "refunds.manage"),
    ownershipScope: supportCase.ownershipScope,
    updatedAt: supportCase.updatedAt,
  };
}

type ActionInput<Action extends CaseAction["action"]> = Extract<
  CaseAction,
  { action: Action }
>;

async function replayCaseActionTx(tx: Tx, caseId: string, input: CaseAction) {
  const where = {
    caseId_clientActionId: { caseId, clientActionId: input.clientActionId },
  };
  switch (input.action) {
    case "REQUEST_EVIDENCE":
      return tx.supportCaseEvidenceRequest.findUnique({ where });
    case "RECOMMEND_REFUND":
      return tx.supportFinancialRecommendation.findUnique({ where });
    case "DECIDE":
      return tx.supportCaseDecision.findUnique({ where });
    case "REVIEW_REFUND": {
      const prior = await tx.supportFinancialRecommendation.findFirst({
        where: { id: input.recommendationId, caseId, decidedAt: { not: null } },
      });
      if (prior && prior.approved !== input.approve)
        throw new CaseActionError(
          "ALREADY_DECIDED",
          "This recommendation already has a decision.",
        );
      return prior;
    }
    default:
      return null;
  }
}

async function stageDecisionNotificationsTx(
  tx: Tx,
  supportCase: SupportCase,
  decision: SupportCaseDecision,
) {
  const caseId = supportCase.id;
  if (supportCase.externalRequesterEmail) {
    const text = `Reference: ${supportCase.referenceNumber}\n\n${decision.explanation}`;
    const html = text
      .replace(
        /[&<>"']/g,
        (character) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[character] ?? character,
      )
      .replace(/\n/g, "<br>");
    await stageEmail(
      {
        from: DEFAULT_FROM_ADDRESS,
        to: supportCase.externalRequesterEmail,
        subject: `Support decision — ${supportCase.referenceNumber}`,
        html,
        text,
      },
      "SUPPORT_TICKET_UPDATE",
      { tx, entityRef: `decision:${decision.id}` },
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

async function recordCaseDecisionTx(
  tx: Tx,
  supportCase: SupportCase,
  actor: CaseActor,
  input: ActionInput<"DECIDE">,
) {
  const caseId = supportCase.id;
  let restoredConsultantProfileId: string | undefined;
  if (
    input.outcome === "OVERTURNED" &&
    supportCase.appealOfModerationActionId
  ) {
    const reversal = await reverseAppealedModeration(
      tx,
      supportCase.appealOfModerationActionId,
      actor,
      input.explanation,
    );
    if (!reversal.ok)
      throw new CaseActionError("COMPENSATING_ACTION_REQUIRED", reversal.error);
    restoredConsultantProfileId = reversal.consultantProfileId;
  }
  const moved = await executePatchLifecycleTx(
    tx,
    {
      caseId,
      actorId: actor.userId,
      expectedUpdatedAt: input.expectedUpdatedAt,
      status: "RESOLVED",
      closingMessage: input.explanation,
    },
    new Date(),
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
  await stageDecisionNotificationsTx(tx, supportCase, decision);
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
  await privateEvent(
    tx,
    caseId,
    actor.userId,
    `Evidence requested: ${request.id}`,
  );
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
  const recommendation = await tx.supportFinancialRecommendation.create({
    data: {
      caseId,
      paymentId: input.paymentId,
      proposedById: actor.userId,
      clientActionId: input.clientActionId,
      amountPaise: input.amountPaise,
      reason: input.reason,
    },
  });
  await privateEvent(
    tx,
    caseId,
    actor.userId,
    `Financial recommendation: ${recommendation.id}`,
  );
  return recommendation;
}

async function reviewRefundTx(
  tx: Tx,
  caseId: string,
  actor: CaseActor,
  input: ActionInput<"REVIEW_REFUND">,
) {
  const recommendation = await tx.supportFinancialRecommendation.findFirst({
    where: { id: input.recommendationId, caseId },
  });
  if (!recommendation)
    throw new CaseActionError("NOT_FOUND", "Recommendation not found.", 404);
  if (recommendation.decidedAt) {
    if (recommendation.approved !== input.approve)
      throw new CaseActionError(
        "ALREADY_DECIDED",
        "This recommendation already has a decision.",
      );
    return recommendation;
  }
  const payment = await linkedPayment(tx, caseId, recommendation.paymentId);
  const refundable = refundableBalancePaise(Number(payment.amount), payment);
  if (input.approve && input.expectedRefundablePaise !== refundable)
    throw new CaseActionError(
      "PREVIEW_CHANGED",
      "Refresh the refund preview before approving.",
    );
  if (input.approve && Number(recommendation.amountPaise) > refundable)
    throw new CaseActionError(
      "AMOUNT_EXCEEDS_REFUNDABLE",
      "The recommendation exceeds the refundable balance.",
    );
  const claimed = await tx.supportFinancialRecommendation.updateMany({
    where: { id: recommendation.id, decidedAt: null },
    data: {
      decidedAt: new Date(),
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
  await privateEvent(
    tx,
    caseId,
    actor.userId,
    `${input.approve ? "Approved" : "Declined"} financial recommendation: ${recommendation.id}`,
  );
  return { ...recommendation, approved: input.approve };
}

async function applyPaymentHoldTx(
  tx: Tx,
  caseId: string,
  actor: CaseActor,
  input: ActionInput<"APPLY_HOLD">,
) {
  await linkedPayment(tx, caseId, input.paymentId);
  const inFlight = await tx.consultantEarnings.findFirst({
    where: {
      paymentId: input.paymentId,
      payout: { status: "PROCESSING" },
    },
    select: { id: true },
  });
  const orgInFlight = await tx.organizationEarnings.findFirst({
    where: {
      paymentId: input.paymentId,
      orgPayout: { status: "PROCESSING" },
    },
    select: { id: true },
  });
  if (inFlight || orgInFlight)
    throw new CaseActionError(
      "PAYOUT_IN_FLIGHT",
      "A linked payout is already being sent. Review it before applying this hold.",
    );
  const existing = await tx.supportPaymentHold.findFirst({
    where: { caseId, paymentId: input.paymentId, releasedAt: null },
  });
  if (existing) return existing;
  const hold = await tx.supportPaymentHold.create({
    data: {
      caseId,
      paymentId: input.paymentId,
      appliedById: actor.userId,
      reason: input.reason,
    },
  });
  await privateEvent(
    tx,
    caseId,
    actor.userId,
    `Payment hold applied: ${hold.id}`,
  );
  return hold;
}

async function releasePaymentHoldTx(
  tx: Tx,
  caseId: string,
  actor: CaseActor,
  input: ActionInput<"RELEASE_HOLD">,
) {
  const released = await tx.supportPaymentHold.updateMany({
    where: { id: input.holdId, caseId, releasedAt: null },
    data: {
      releasedAt: new Date(),
      releasedById: actor.userId,
      releaseReason: input.reason,
    },
  });
  if (!released.count)
    throw new CaseActionError("CONFLICT", "This hold was already released.");
}

async function performCaseActionTx(
  tx: Tx,
  caseId: string,
  actor: CaseActor,
  input: CaseAction,
) {
  const supportCase = await tx.supportCase.findFirst({
    where: { id: caseId, deletedAt: null },
  });
  if (!supportCase || !(await canCorrespondOnCase(supportCase, actor, tx)))
    throw new CaseActionError("NOT_FOUND", "Support case not found.", 404);
  if (supportCase.appealOfDecisionId || supportCase.appealOfModerationActionId)
    await assertIndependentReviewer(tx, supportCase, actor.userId);
  const replay = await replayCaseActionTx(tx, caseId, input);
  if (replay) return replay;
  if (input.action === "DECIDE")
    return recordCaseDecisionTx(tx, supportCase, actor, input);
  const touched = await tx.supportCase.updateMany({
    where: { id: caseId, updatedAt: new Date(input.expectedUpdatedAt) },
    data: { updatedAt: new Date() },
  });
  if (touched.count !== 1)
    throw new CaseActionError(
      "CONFLICT",
      "This case changed. Refresh before continuing.",
    );
  switch (input.action) {
    case "REQUEST_EVIDENCE":
      return requestEvidenceTx(tx, supportCase, actor, input);
    case "RECOMMEND_REFUND":
      return recommendRefundTx(tx, caseId, actor, input);
    case "REVIEW_REFUND":
      return reviewRefundTx(tx, caseId, actor, input);
    case "APPLY_HOLD":
      return applyPaymentHoldTx(tx, caseId, actor, input);
    case "CANCEL_EVIDENCE":
      await cancelEvidenceTx(tx, caseId, input);
      break;
    case "RELEASE_HOLD":
      await releasePaymentHoldTx(tx, caseId, actor, input);
      break;
    case "HANDOVER":
      if (supportCase.ownershipScope === "PERSONAL")
        throw new CaseActionError(
          "PERSONAL_CASE",
          "Personal correspondence cannot be handed over to an organization.",
          403,
        );
      break;
  }
  await privateEvent(
    tx,
    caseId,
    actor.userId,
    `${input.action}: ${input.reason}`,
  );
  return { ok: true };
}

export async function performCaseAction(
  caseId: string,
  actor: CaseActor,
  input: CaseAction,
) {
  const financial =
    ["REVIEW_REFUND", "APPLY_HOLD", "RELEASE_HOLD"].includes(input.action) ||
    (input.action === "DECIDE" &&
      ["REFUND_APPROVED", "REFUND_DECLINED"].includes(input.outcome));
  if (
    !hasBackofficePermission(
      actor.role,
      financial ? "refunds.manage" : "tickets.manage",
    ) &&
    input.action !== "HANDOVER"
  )
    throw new CaseActionError(
      "FORBIDDEN",
      "This action is not available to your role.",
      403,
    );
  const result = await withSerializableRetry(() =>
    prisma.$transaction((tx) => performCaseActionTx(tx, caseId, actor, input), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    }),
  );
  if (input.action === "DECIDE" && input.outcome === "OVERTURNED")
    purgeReviewSurfaces(
      "restoredConsultantProfileId" in result &&
        typeof result.restoredConsultantProfileId === "string"
        ? result.restoredConsultantProfileId
        : undefined,
    );
  if (input.action === "REVIEW_REFUND" && input.approve) {
    const recommendation =
      await prisma.supportFinancialRecommendation.findFirstOrThrow({
        where: { id: input.recommendationId, caseId, approved: true },
      });
    const dedupeKey = `case-recommendation:${recommendation.id}`;
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: recommendation.paymentId },
      select: { paymentIntent: true },
    });
    const refund = await refundBookingPayment({
      paymentId: recommendation.paymentId,
      ...(payment.paymentIntent.startsWith("free_")
        ? {}
        : { amountPaise: Number(recommendation.amountPaise) }),
      reason: recommendation.reason,
      initiatedByUserId: actor.userId,
      dedupeKey,
      supportRecommendationId: recommendation.id,
    }).catch((error: unknown) => refundInFlightOr(error, dedupeKey));
    return { ...result, refund };
  }
  return result;
}
