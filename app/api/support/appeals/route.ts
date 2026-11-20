import { NextRequest, NextResponse } from "next/server";
import { Prisma, type SupportCaseOwnership } from "@prisma/client";
import { z } from "zod";
import { addMonths } from "date-fns";
import prisma, { type Tx } from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { canCorrespondOnCase } from "@/lib/support/case-access";
import { allocateTicketReference } from "@/lib/support/reference";
import { supportDeadline } from "@/lib/support/deadline-policy";
import { slaDeadlinesFor } from "@/lib/support/sla";
import { CaseActionError } from "@/lib/support/case-actions";
import { stageCaseNotice } from "@/lib/support/case-notice";
import { latestCaseDecisionTx } from "@/lib/support/case-service";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import { assertBodySize } from "@/lib/validation/limits";
import { supportError } from "@/lib/api/support-http";
const Input = z
  .object({
    decisionId: z.string().min(1).max(64).optional(),
    moderationActionId: z.string().min(1).max(64).optional(),
    reason: z.string().trim().min(1).max(10_000),
    clientIntakeId: z.string().min(1).max(128),
  })
  .refine(
    (value) =>
      Number(Boolean(value.decisionId)) +
        Number(Boolean(value.moderationActionId)) ===
      1,
    "Choose one decision to appeal",
  );

interface AppealScope {
  organizationId: string | null;
  ownershipScope: SupportCaseOwnership;
  originalReviewer: string | null;
}

async function decisionAppealScope(
  tx: Tx,
  decisionId: string,
  userId: string,
  now: Date,
): Promise<AppealScope> {
  const decision = await tx.supportCaseDecision.findUnique({
    where: { id: decisionId },
    include: { supportCase: true, supersededBy: { select: { id: true } } },
  });
  if (!decision)
    throw new CaseActionError("NOT_FOUND", "Decision not found.", 404);
  const canCorrespond = await canCorrespondOnCase(
    decision.supportCase,
    { userId, role: "CONSULTEE" },
    tx,
  );
  const evidenceParty = await tx.supportCaseEvidenceRequest.findFirst({
    where: { caseId: decision.caseId, recipientUserId: userId },
    select: { id: true },
  });
  if (!canCorrespond && !evidenceParty)
    throw new CaseActionError("NOT_FOUND", "Decision not found.", 404);
  if (
    decision.supportCase.appealOfDecisionId ||
    decision.supportCase.appealOfModerationActionId
  )
    throw new CaseActionError(
      "FINAL_DECISION",
      "This decision already follows an appeal.",
    );
  if (decision.supersededBy) {
    const latest = await latestCaseDecisionTx(tx, decision.caseId);
    throw new CaseActionError(
      "DECISION_SUPERSEDED",
      "This decision was replaced by a newer one. Appeal the latest decision instead.",
      409,
      { latestDecisionId: latest?.id ?? decision.supersededBy.id },
    );
  }
  if (now > decision.appealUntil)
    throw new CaseActionError(
      "APPEAL_EXPIRED",
      "The appeal window has ended.",
      400,
    );
  return {
    organizationId: canCorrespond ? decision.supportCase.organizationId : null,
    ownershipScope: canCorrespond
      ? decision.supportCase.ownershipScope
      : "PERSONAL",
    originalReviewer: decision.decidedById,
  };
}

async function moderationAppealScope(
  tx: Tx,
  moderationActionId: string | undefined,
  userId: string,
  now: Date,
): Promise<AppealScope> {
  const action = await tx.moderationAction.findUnique({
    where: { id: moderationActionId },
    include: {
      report: { select: { reportedById: true, targetUserId: true } },
      review: {
        select: {
          consulteeProfile: { select: { userId: true } },
          consultantProfile: {
            select: { user: { select: { id: true } } },
          },
        },
      },
      feedback: { select: { userId: true } },
    },
  });
  const eligible =
    action &&
    (action.report?.reportedById === userId ||
      action.report?.targetUserId === userId ||
      action.review?.consulteeProfile.userId === userId ||
      action.review?.consultantProfile.user?.id === userId ||
      action.feedback?.userId === userId);
  if (!action || !eligible)
    throw new CaseActionError("NOT_FOUND", "Decision not found.", 404);
  if (now > addMonths(action.createdAt, 6))
    throw new CaseActionError(
      "APPEAL_EXPIRED",
      "The appeal window has ended.",
      400,
    );
  return {
    organizationId: null,
    ownershipScope: "PERSONAL",
    originalReviewer: action.takenById,
  };
}

export async function POST(req: NextRequest) {
  const auth = await requireApiAuth({ expectUser: true });
  if (auth.error) return auth.error;
  const limited = await applyRateLimit(
    spamLimiter,
    `support-appeal:${auth.session.user.id}`,
  );
  if (limited) return limited;
  const tooLarge = assertBodySize(req);
  if (tooLarge) return tooLarge;
  const parsed = Input.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: "Choose a decision and explain your appeal" },
      { status: 400 },
    );
  const input = parsed.data;
  const userId = auth.session.user.id;
  const where = {
    submitterUserId: userId,
    ...(input.decisionId
      ? { appealOfDecisionId: input.decisionId }
      : { appealOfModerationActionId: input.moderationActionId }),
  };
  try {
    const supportCase = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const prior = await tx.supportCase.findFirst({ where });
          if (prior) return prior;
          const now = new Date();
          const { organizationId, ownershipScope, originalReviewer } =
            input.decisionId
              ? await decisionAppealScope(tx, input.decisionId, userId, now)
              : await moderationAppealScope(
                  tx,
                  input.moderationActionId,
                  userId,
                  now,
                );
          const referenceNumber = await allocateTicketReference(tx, now);
          const supportCase = await tx.supportCase.create({
            data: {
              referenceNumber,
              clientIntakeId: input.clientIntakeId,
              title: "Appeal of a platform decision",
              description: input.reason,
              category: input.moderationActionId
                ? "MODERATION_APPEAL"
                : "SERVICE_APPEAL",
              requesterUserId: userId,
              submitterUserId: userId,
              organizationId,
              ownershipScope,
              scopeKey: `${input.decisionId ? "CASE_DECISION" : "MODERATION_ACTION"}:${input.decisionId ?? input.moderationActionId}`,
              appealOfDecisionId: input.decisionId,
              appealOfModerationActionId: input.moderationActionId,
              activeChannel: "HUMAN",
              priority: "HIGH",
              ...slaDeadlinesFor("HIGH", now),
              ...supportDeadline("GRIEVANCE", now),
              receivedAt: now,
              messageSeq: 1,
              lastMessageAt: now,
              messages: {
                create: {
                  seq: 1,
                  sender: "USER",
                  authorUserId: userId,
                  body: input.reason,
                  clientTurnId: input.clientIntakeId,
                },
              },
              events: {
                create: { kind: "CREATED", actorId: userId, toValue: "OPEN" },
              },
            },
          });
          const reviewers = await tx.user.findMany({
            where: {
              role: { in: ["STAFF", "ADMIN"] },
              banned: false,
              ...(originalReviewer ? { id: { not: originalReviewer } } : {}),
            },
            select: { id: true },
          });
          await stageCaseNotice(
            tx,
            supportCase,
            reviewers.map((reviewer) => reviewer.id),
            "Independent appeal review needed",
            `appeal:${supportCase.id}`,
          );
          return supportCase;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
    return NextResponse.json(
      {
        data: {
          id: supportCase.id,
          referenceNumber: supportCase.referenceNumber,
          status: supportCase.status,
          caseKey: `c_${supportCase.id}`,
        },
      },
      { status: 201 },
    );
  } catch (cause) {
    if (cause instanceof CaseActionError)
      return NextResponse.json(
        { error: cause.message, code: cause.code, ...cause.detail },
        { status: cause.status },
      );
    if (
      cause instanceof Prisma.PrismaClientKnownRequestError &&
      cause.code === "P2002"
    ) {
      const prior = await prisma.supportCase.findFirst({ where });
      if (prior)
        return NextResponse.json({
          data: {
            id: prior.id,
            referenceNumber: prior.referenceNumber,
            status: prior.status,
            caseKey: `c_${prior.id}`,
          },
        });
      return supportError({
        status: 409,
        code: "CONFLICT",
        message: "This request was already used. Refresh and try again.",
        context: { route: "support.appeals" },
      });
    }
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "support.appeals" },
    });
  }
}
