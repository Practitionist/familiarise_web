import prisma from "@/lib/prisma";
import { BookingHistoryEntity } from "@prisma/client";

/**
 * #1703 D4 — a consultant's request response rate, read from
 * BookingStatusHistory: of the PENDING → APPROVED / APPROVED_PENDING_PAYMENT /
 * REJECTED transitions in the last 30 days, the share that landed within 24 h
 * of the request's creation row. Read-only on Home; no ranking use yet.
 */

export const RESPONSE_RATE_WINDOW_DAYS = 30;
export const RESPONSE_RATE_TARGET_MS = 24 * 60 * 60 * 1000;

/** The answers that count; auto-expiry is not an answer. */
const ANSWER_STATUSES = ["APPROVED", "APPROVED_PENDING_PAYMENT", "REJECTED"];

export interface ResponseRate {
  /** Answers inside the target. */
  withinTarget: number;
  /** Answers with a known request time, inside the window. */
  total: number;
  /** Rounded percentage, or null when there is nothing to measure. */
  withinTargetPct: number | null;
}

export const EMPTY_RESPONSE_RATE: ResponseRate = {
  withinTarget: 0,
  total: 0,
  withinTargetPct: null,
};

/**
 * Pure: pairs each answer with its request's creation instant. An answer whose
 * request row has no creation stamp is left out of both counts rather than
 * counted against the consultant.
 */
export function computeResponseRate(
  answers: ReadonlyArray<{ entityId: string; createdAt: Date }>,
  requestedAtByEntity: ReadonlyMap<string, Date>,
): ResponseRate {
  let total = 0;
  let withinTarget = 0;
  for (const answer of answers) {
    const requestedAt = requestedAtByEntity.get(answer.entityId);
    if (!requestedAt) continue;
    total += 1;
    if (
      answer.createdAt.getTime() - requestedAt.getTime() <=
      RESPONSE_RATE_TARGET_MS
    ) {
      withinTarget += 1;
    }
  }
  return {
    withinTarget,
    total,
    withinTargetPct:
      total === 0 ? null : Math.round((withinTarget / total) * 100),
  };
}

export async function getConsultantResponseRate(
  consultantProfileId: string,
  now = new Date(),
): Promise<ResponseRate> {
  const since = new Date(
    now.getTime() - RESPONSE_RATE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const answers = await prisma.bookingStatusHistory.findMany({
    where: {
      entity: {
        in: [
          BookingHistoryEntity.CONSULTATION,
          BookingHistoryEntity.SUBSCRIPTION,
        ],
      },
      fromStatus: "PENDING",
      toStatus: { in: ANSWER_STATUSES },
      createdAt: { gte: since },
      appointment: {
        OR: [
          { consultation: { consultationPlan: { consultantProfileId } } },
          { subscription: { subscriptionPlan: { consultantProfileId } } },
        ],
      },
    },
    select: { entityId: true, createdAt: true },
  });
  if (answers.length === 0) return EMPTY_RESPONSE_RATE;

  // The creation row (#1333) is the request's clock; earliest one per entity.
  const created = await prisma.bookingStatusHistory.findMany({
    where: {
      entityId: { in: [...new Set(answers.map((a) => a.entityId))] },
      fromStatus: "CREATED",
    },
    select: { entityId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const requestedAtByEntity = new Map<string, Date>();
  for (const row of created) {
    if (!requestedAtByEntity.has(row.entityId)) {
      requestedAtByEntity.set(row.entityId, row.createdAt);
    }
  }
  return computeResponseRate(answers, requestedAtByEntity);
}
