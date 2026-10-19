import { z } from "zod";
import type {
  Prisma,
  PurchaseDisputeActionKind,
  PurchaseDisputeStatus,
} from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { assertLegalDisputeTransition } from "./protocol";
import { respondentDueAt } from "./deadlines";

/**
 * The protocol's actions.
 *
 * Every action carries two guards:
 *
 *   `clientActionId` — the idempotency anchor. One row per (dispute, key) in
 *   `PurchaseDisputeAction`, so a double-click, a retried request or a
 *   replayed webhook is ONE transition, not two. Reusing a key with a
 *   different body is refused, not replayed.
 *
 *   `expectedVersion` — the optimistic-concurrency guard. The transition is a
 *   conditional update whose WHERE carries the expected status AND the
 *   expected version, so exactly one of two concurrent actions wins and the
 *   loser is told what the winner did.
 *
 * `expectedVersion` is deliberately not `updatedAt`: the case's `updatedAt`
 * also moves when a message is appended, so an unrelated message would read
 * as a protocol conflict and the agent would be told to retry a move that
 * had already happened.
 */

const id = z.string().min(1).max(128);
const body = z.string().trim().min(1).max(10_000);
const note = z.string().trim().min(1).max(10_000).optional();

const base = z.object({
  clientActionId: id,
  expectedVersion: z.number().int().min(1),
});

export const DisputeActionSchema = z.discriminatedUnion("action", [
  base.extend({
    action: z.literal("RESPOND"),
    response: body,
    acceptRefund: z.boolean(),
  }),
  base.extend({ action: z.literal("BUYER_ACCEPT"), note }),
  base.extend({ action: z.literal("BUYER_REJECT"), note }),
  base.extend({ action: z.literal("ESCALATE"), reason: body }),
  base.extend({ action: z.literal("UNDER_REVIEW"), reason: body }),
  base.extend({
    action: z.literal("RESOLVE"),
    resolution: z.enum(["REFUND_FULL", "REFUND_PARTIAL", "NO_REMEDY"]),
    note,
  }),
  base.extend({ action: z.literal("WITHDRAW"), reason: body }),
  base.extend({
    action: z.literal("CHOOSE_REFUND_METHOD"),
    refundMethod: z.enum(["ORIGINAL_METHOD", "PLATFORM_CREDITS"]),
    /**
     * The buyer's specific agreement. Required for PLATFORM_CREDITS: RBI
     * PA/PG §12.4 says refunds go to the original method unless the
     * customer specifically agrees otherwise, and this is where that
     * agreement is recorded. The database refuses a credits refund without
     * a consent stamp.
     */
    consent: z.boolean().optional(),
  }),
]);

export type DisputeAction = z.infer<typeof DisputeActionSchema>;

export class DisputeActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DisputeActionError";
  }
}

export interface DisputeActor {
  userId: string;
  role: "CONSULTANT" | "CONSULTEE" | "ADMIN" | "STAFF" | "ORG_WORKSPACE";
}
/**
 * May this actor perform this action on this dispute?
 *
 * The respondent, the buyer and the platform each own a different set of
 * moves, and the ownership is checked against the DISPUTE'S OWN FIELDS — not
 * against a role list — so a platform operator who is also the buyer of
 * some other dispute cannot use that to answer this one.
 */
export function mayPerform(
  action: DisputeAction["action"],
  dispute: {
    buyerUserId: string;
    respondentUserId: string | null;
    respondentOrganizationId: string | null;
  },
  actor: DisputeActor,
  isRespondentMember: boolean,
): boolean {
  switch (action) {
    case "RESPOND":
      return (
        (dispute.respondentUserId !== null &&
          dispute.respondentUserId === actor.userId) ||
        isRespondentMember
      );
    case "BUYER_ACCEPT":
    case "BUYER_REJECT":
    case "WITHDRAW":
    case "CHOOSE_REFUND_METHOD":
      return dispute.buyerUserId === actor.userId;
    case "ESCALATE":
    case "UNDER_REVIEW":
    case "RESOLVE":
      return hasBackofficePermission(actor.role, "tickets.manage");
    default:
      return false;
  }
}

/**
 * The status each action moves the dispute to, and the row it writes to the
 * append-only action log.
 */
function targetOf(
  action: DisputeAction,
): { status: PurchaseDisputeStatus; kind: PurchaseDisputeActionKind } {
  switch (action.action) {
    case "RESPOND":
      return { status: "RESPONDED", kind: "RESPONDED" };
    case "BUYER_ACCEPT":
      return { status: "RESOLVED", kind: "BUYER_ACCEPTED" };
    case "BUYER_REJECT":
      return { status: "ESCALATED", kind: "BUYER_REJECTED" };
    case "ESCALATE":
      return { status: "ESCALATED", kind: "ESCALATED" };
    case "UNDER_REVIEW":
      return { status: "UNDER_REVIEW", kind: "UNDER_REVIEW" };
    case "RESOLVE":
      return { status: "RESOLVED", kind: "RESOLVED" };
    case "WITHDRAW":
      return { status: "WITHDRAWN", kind: "WITHDRAWN" };
    case "CHOOSE_REFUND_METHOD":
      // Choosing where the refund goes is not a protocol transition; it is a
      // choice recorded against the current status.
      return { status: "RESPONDED", kind: "REFUND_METHOD_CHOSEN" };
    default:
      return { status: "OPEN", kind: "RESPONDED" };
  }
}

const DISPUTE_SELECT = {
  id: true,
  supportCaseId: true,
  status: true,
  version: true,
  round: true,
  buyerUserId: true,
  respondentUserId: true,
  respondentOrganizationId: true,
  respondentType: true,
  respondentAcceptedRefund: true,
  respondentDueAt: true,
  amountAtStakePaise: true,
  refundMethod: true,
  refundMethodConsentedAt: true,
  escalatedAt: true,
  resolvedAt: true,
  createdAt: true,
} as const;

/**
 * Perform one protocol action.
 *
 * The whole thing runs in ONE Serializable transaction, so the read, the
 * legality check, the conditional update and the action-log row are one
 * atomic step. Two agents pressing the same button produce one winner and
 * one 409 — never two transitions.
 */
export async function performDisputeAction(
  disputeId: string,
  actor: DisputeActor,
  input: DisputeAction,
): Promise<{ replayed: boolean; status: PurchaseDisputeStatus; version: number }> {
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const dispute = await tx.purchaseDispute.findUnique({
          where: { id: disputeId },
          select: DISPUTE_SELECT,
        });
        if (!dispute) {
          throw new DisputeActionError("NOT_FOUND", "Dispute not found.", 404);
        }

        // The idempotency replay. Same key, same action: this already
        // happened, so answer with what happened rather than doing it again.
        const replay = await tx.purchaseDisputeAction.findUnique({
          where: {
            disputeId_clientActionId: {
              disputeId,
              clientActionId: input.clientActionId,
            },
          },
          select: { kind: true, toStatus: true, payload: true },
        });
        if (replay) {
          const current = await tx.purchaseDispute.findUnique({
            where: { id: disputeId },
            select: { status: true, version: true },
          });
          return {
            replayed: true,
            status: current?.status ?? replay.toStatus ?? dispute.status,
            version: current?.version ?? dispute.version,
          };
        }

        const isRespondentMember = await isOrganizationRespondent(
          tx,
          dispute.respondentOrganizationId,
          actor.userId,
        );
        if (!mayPerform(input.action, dispute, actor, isRespondentMember)) {
          throw new DisputeActionError(
            "FORBIDDEN",
            "This action is not available to you on this dispute.",
            403,
          );
        }

        const { status: toStatus, kind } = targetOf(input);

        // Choosing a refund method does not move the protocol.
        if (input.action !== "CHOOSE_REFUND_METHOD") {
          try {
            assertLegalDisputeTransition(dispute.status, toStatus);
          } catch (cause) {
            // An illegal transition is a refusal, not a crash: the route
            // answers 409 with a code, not 500.
            throw new DisputeActionError(
              "ILLEGAL_TRANSITION",
              cause instanceof Error ? cause.message : "That move is not available on this dispute.",
              409,
            );
          }
        } else if (
          dispute.status === "RESOLVED" ||
          dispute.status === "WITHDRAWN" ||
          dispute.status === "CLOSED"
        ) {
          throw new DisputeActionError(
            "CONFLICT",
            "This dispute is closed, so the refund method cannot change.",
          );
        }

        if (
          input.action === "CHOOSE_REFUND_METHOD" &&
          input.refundMethod === "PLATFORM_CREDITS" &&
          input.consent !== true
        ) {
          throw new DisputeActionError(
            "CONSENT_REQUIRED",
            "A platform-credit refund needs the buyer's explicit agreement, recorded with it.",
            400,
          );
        }

        // THE CAS. The expected status AND the expected version are both in
        // the WHERE, so exactly one concurrent action wins.
        const data: Prisma.PurchaseDisputeUpdateManyMutationInput = {
          status: toStatus,
          version: { increment: 1 },
        };
        if (input.action === "RESPOND") {
          data.respondentResponse = input.response;
          data.respondentAcceptedRefund = input.acceptRefund;
          data.respondentRespondedAt = new Date();
          data.round = { increment: 1 };
        }
        if (input.action === "BUYER_ACCEPT") {
          data.buyerDecision = "ACCEPTED";
          data.buyerDecisionAt = new Date();
          data.resolvedAt = new Date();
        }
        if (input.action === "BUYER_REJECT") {
          data.buyerDecision = "REJECTED";
          data.buyerDecisionAt = new Date();
          data.escalatedAt = new Date();
          data.escalatedReason = "BUYER_REJECTED_RESPONSE";
        }
        if (input.action === "ESCALATE") {
          data.escalatedAt = new Date();
          data.escalatedReason = "ESCALATED_BY_STAFF";
        }
        if (input.action === "RESOLVE") {
          data.resolvedAt = new Date();
        }
        if (input.action === "WITHDRAW") {
          data.resolvedAt = new Date();
        }
        if (input.action === "CHOOSE_REFUND_METHOD") {
          data.refundMethod = input.refundMethod;
          data.refundMethodChosenAt = new Date();
          if (input.refundMethod === "PLATFORM_CREDITS" && input.consent) {
            data.refundMethodConsentedAt = new Date();
          }
        }

        if (input.action === "CHOOSE_REFUND_METHOD") {
          // Choosing a refund method is not a protocol transition: it does
          // not move the status, so the write asserts the status it read.
          data.status = dispute.status;
        }

        const moved = await tx.purchaseDispute.updateMany({
          where: {
            id: disputeId,
            status: dispute.status,
            version: input.expectedVersion,
          },
          data,
        });
        if (moved.count === 0) {
          const current = await tx.purchaseDispute.findUnique({
            where: { id: disputeId },
            select: { status: true, version: true },
          });
          throw new DisputeActionError(
            "CONFLICT",
            "This dispute moved while you were working on it. Review the current state and try again.",
            409,
            { currentStatus: current?.status, currentVersion: current?.version },
          );
        }

        await tx.purchaseDisputeAction.create({
          data: {
            disputeId,
            clientActionId: input.clientActionId,
            kind,
            fromStatus: dispute.status,
            toStatus:
              input.action === "CHOOSE_REFUND_METHOD"
                ? dispute.status
                : toStatus,
            actorUserId: actor.userId,
            payload: { action: input.action },
          },
        });

        const after = await tx.purchaseDispute.findUnique({
          where: { id: disputeId },
          select: { status: true, version: true },
        });
        return {
          replayed: false,
          status: after?.status ?? toStatus,
          version: after?.version ?? dispute.version + 1,
        };
      },
      { isolationLevel: "Serializable" },
    ),
  );
}

async function isOrganizationRespondent(
  tx: Tx,
  organizationId: string | null,
  userId: string,
): Promise<boolean> {
  if (!organizationId) return false;
  const member = await tx.membership.findFirst({
    where: {
      organizationId,
      userId,
      status: "ACTIVE",
      role: { in: ["OWNER", "MAINTAINER"] },
    },
    select: { id: true },
  });
  return member !== null;
}

/**
 * The sweep's escalation: a respondent who missed their window hands the
 * dispute to the platform. It is the same conditional update as every other
 * transition, so a respondent answering at the same moment loses cleanly
 * rather than being overwritten.
 */
export async function escalateForMissedWindow(
  tx: Tx,
  disputeId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const moved = await tx.purchaseDispute.updateMany({
    where: {
      id: disputeId,
      status: "OPEN",
      respondentDueAt: { lt: now },
    },
    data: {
      status: "ESCALATED",
      version: { increment: 1 },
      escalatedAt: now,
      escalatedReason: "RESPONDENT_WINDOW_PASSED",
    },
  });
  return moved.count > 0;
}

/** The default respondent deadline, used when a dispute is raised. */
export function defaultRespondentDueAt(now: Date = new Date()): Date {
  return respondentDueAt(now);
}
