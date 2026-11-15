import prisma, { type PrismaLike } from "@/lib/prisma";
import { DEADLINE_HOURS } from "./deadline-policy";

/** The support case category a host's conduct removal opens for the removed attendee. */
export const CONDUCT_REMOVAL_CATEGORY = "CONDUCT_REMOVAL";

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
 * False when there is none or support overturned it.
 */
export async function conductRemovalStands(
  appointmentId: string,
  userId: string,
  db: PrismaLike = prisma,
): Promise<boolean> {
  const removal = await db.supportCase.findFirst({
    where: {
      appointmentId,
      requesterUserId: userId,
      category: CONDUCT_REMOVAL_CATEGORY,
      deletedAt: null,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return removal ? !(await removalOverturned(db, removal.id)) : false;
}
