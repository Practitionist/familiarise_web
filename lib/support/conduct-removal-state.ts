import prisma, { type PrismaLike } from "@/lib/prisma";
import type { RequiredNoticeKind } from "@/lib/notifications/required-notices";
import { CONDUCT_REMOVAL_CATEGORY } from "./case-topic";
import { DEADLINE_HOURS } from "./deadline-policy";

/** How long support has to decide a conduct removal before the seat's unrefunded balance is owed. */
export const CONDUCT_REMOVAL_REVIEW_HOURS = DEADLINE_HOURS.CONDUCT_REMOVAL;

/** The key every refund a conduct removal owes carries, on overturn and on the deadline alike. */
export const conductRemovalRefundKey = (caseId: string) =>
  `conduct-removal:${caseId}`;

/** A decision no later decision supersedes. */
const IN_FORCE = { supersededBy: { is: null } } as const;

/**
 * The conduct removal case a decided case reviews: the case itself, or the
 * removal case whose decision it appeals. Null for any other case.
 */
export async function reviewedRemovalCaseId(
  db: PrismaLike,
  supportCase: {
    id: string;
    category: string | null;
    appealOfDecisionId: string | null;
  },
): Promise<string | null> {
  if (supportCase.category === CONDUCT_REMOVAL_CATEGORY) return supportCase.id;
  if (!supportCase.appealOfDecisionId) return null;
  const appealed = await db.supportCaseDecision.findFirst({
    where: {
      id: supportCase.appealOfDecisionId,
      supportCase: { category: CONDUCT_REMOVAL_CATEGORY },
    },
    select: { caseId: true },
  });
  return appealed?.caseId ?? null;
}

/**
 * True once the removal is overturned: the decision in force on the removal
 * case, or on an appeal of it, is OVERTURNED.
 */
async function removalOverturned(
  db: PrismaLike,
  removalCaseId: string,
): Promise<boolean> {
  const overturned = await db.supportCaseDecision.findFirst({
    where: {
      ...IN_FORCE,
      outcome: "OVERTURNED",
      OR: [
        { caseId: removalCaseId },
        { supportCase: { appealOfDecision: { caseId: removalCaseId } } },
      ],
    },
    select: { id: true },
  });
  return overturned !== null;
}

/**
 * Whether the user's latest conduct removal from the appointment still stands.
 * False when there is none, support overturned it, or its block on the seat was lifted.
 */
export async function conductRemovalStands(
  appointmentId: string,
  userId: string,
  db: PrismaLike = prisma,
): Promise<boolean> {
  const seat = await db.appointmentParticipant.findUnique({
    where: { appointmentId_userId: { appointmentId, userId } },
    select: { id: true, removedByUserId: true },
  });
  if (!seat?.removedByUserId) return false;
  const removal = await db.supportCase.findFirst({
    where: {
      appointmentId,
      requesterUserId: userId,
      category: CONDUCT_REMOVAL_CATEGORY,
      deletedAt: null,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true },
  });
  if (!removal || (await removalOverturned(db, removal.id))) return false;
  // A lift after the removal ends it for good; a later plain removal marks the seat anew.
  const lifted = await db.bookingStatusHistory.findFirst({
    where: {
      entity: "SEAT",
      entityId: seat.id,
      reason: "block_lifted",
      createdAt: { gte: removal.createdAt },
    },
    select: { id: true },
  });
  return lifted === null;
}

/**
 * The required bell the removed learner gets when support decides their removal.
 * An overturn lifts the block: a price-free seat registers again, any other asks support.
 */
export function removalDecisionNotice(
  outcome: "OVERTURNED" | "UPHELD",
  rejoin: "REGISTER" | "SUPPORT" = "SUPPORT",
): {
  message: string;
  required: RequiredNoticeKind;
} {
  const overturned =
    rejoin === "REGISTER"
      ? "Support overturned your removal. Your seat is not given back, but you can register for this event again."
      : "Support overturned your removal. Your seat is not given back and any refund was sent first; support will help you rejoin this event.";
  return {
    message:
      outcome === "OVERTURNED"
        ? overturned
        : "Support upheld your removal. You can appeal within 7 days.",
    required: "SEAT_RELEASED",
  };
}
