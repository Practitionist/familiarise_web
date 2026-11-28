import {
  Prisma,
  type Collaborator,
  type CollaboratorRole,
} from "@prisma/client";
import {
  hostBatchEntries,
  lockHostBatchInTx,
  HostTimeHeldError,
  withHostSlotBatch,
} from "@/lib/booking/host-slot-batch";
import { liveParticipant } from "@/lib/booking/participants";
import {
  assertConsultantAvailableForWindows,
  ConsultantScheduleConflictError,
} from "@/lib/collaborators/availability";
import {
  afterCollaborationEnded,
  endCollaboration,
  type EndedCollaboration,
} from "@/lib/collaborators/ending";
import {
  sendOwedCohostEmails,
  stageCollaboratorNotifications,
} from "@/lib/collaborators/notifications";
import { PRESENTER_ROLES, tierForRole } from "@/lib/collaborators/roles";
import {
  bpsToPercent,
  inviteLapsedBefore,
  MAX_COLLABORATORS_PER_PLAN,
  MAX_TEAM_SHARE_BPS,
  percentToBps,
  reinviteAllowedAt,
} from "@/lib/collaborators/rules";
import {
  livePlanAppointmentsWhere,
  lockPlanRow,
  planWhere,
  type PlanRef,
} from "@/lib/collaborators/team";
import {
  isCheckViolation,
  isDeadlock,
  isUniqueViolation,
  isWriteConflict,
} from "@/lib/db/pg-errors";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import prisma, { type PrismaLike, type Tx } from "@/lib/prisma";
import { grantCollaboratorAccess } from "@/lib/stream/collaborator-access";
import {
  COLLABORATOR_ROLES_BY_PLAN_TYPE,
  MAX_SHARE_PERCENT,
  MIN_SHARE_PERCENT,
  type SeenTerms,
} from "@/schemas/collaborators";
import { OCCUPYING_OCCURRENCE_WHERE } from "@/utils/scheduling-engine/occupancyPolicy";

export type CollaborationErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "INVALID_TERMS"
  | "INVITEE_INELIGIBLE"
  | "NOT_PAYABLE"
  | "ALREADY_ON_PLAN"
  | "HOLDS_A_SEAT"
  | "PLAN_ARCHIVED"
  | "TEAM_FULL"
  | "PRESENTER_TAKEN"
  | "SHARES_EXCEEDED"
  | "COOLDOWN"
  | "RATE_LIMITED"
  | "TERMS_CHANGED"
  | "TERMS_LOCKED"
  | "NOT_PENDING"
  | "CALENDAR_CLASH"
  | "CALENDAR_BUSY"
  | "SCHEDULE_CHANGED"
  | "CONFLICT";

const HTTP_STATUS: Record<CollaborationErrorCode, number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  INVALID_TERMS: 400,
  INVITEE_INELIGIBLE: 400,
  NOT_PAYABLE: 409,
  ALREADY_ON_PLAN: 409,
  HOLDS_A_SEAT: 409,
  PLAN_ARCHIVED: 409,
  TEAM_FULL: 409,
  PRESENTER_TAKEN: 409,
  SHARES_EXCEEDED: 409,
  COOLDOWN: 409,
  RATE_LIMITED: 429,
  TERMS_CHANGED: 409,
  TERMS_LOCKED: 409,
  NOT_PENDING: 409,
  CALENDAR_CLASH: 409,
  CALENDAR_BUSY: 409,
  SCHEDULE_CHANGED: 409,
  CONFLICT: 409,
};

/**
 * Every refusal the collaborator writes give. `code` is stable for clients,
 * the message is a sentence the person can act on, and `detail` carries the
 * facts a screen needs to recover (the current terms, a retry time).
 */
export class CollaborationError extends Error {
  constructor(
    readonly code: CollaborationErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CollaborationError";
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}

/** The terms of one collaboration, as the screens and clients exchange them. */
export type CollaborationTerms = {
  role: CollaboratorRole;
  sharePercent: number;
};

/** What a write returns: the row's identity, terms and status, nothing private. */
export type CollaborationSummary = Pick<
  Collaborator,
  "id" | "consultantProfileId" | "role" | "tier" | "status" | "revenueShareBps"
> &
  PlanRef;

function summaryOf(row: Collaborator, ref: PlanRef): CollaborationSummary {
  return {
    id: row.id,
    consultantProfileId: row.consultantProfileId,
    role: row.role,
    tier: row.tier,
    status: row.status,
    revenueShareBps: row.revenueShareBps,
    ...ref,
  };
}

const termsOf = (row: {
  role: CollaboratorRole;
  revenueShareBps: number;
}): CollaborationTerms => ({
  role: row.role,
  sharePercent: bpsToPercent(row.revenueShareBps),
});

function assertTerms(ref: PlanRef, terms: Partial<CollaborationTerms>): void {
  const roles: readonly CollaboratorRole[] =
    COLLABORATOR_ROLES_BY_PLAN_TYPE[ref.planType];
  if (terms.role !== undefined && !roles.includes(terms.role)) {
    throw new CollaborationError(
      "INVALID_TERMS",
      `That role is not available on a ${ref.planType}.`,
    );
  }
  if (
    terms.sharePercent !== undefined &&
    (!Number.isInteger(terms.sharePercent) ||
      terms.sharePercent < MIN_SHARE_PERCENT ||
      terms.sharePercent > MAX_SHARE_PERCENT)
  ) {
    throw new CollaborationError(
      "INVALID_TERMS",
      `The revenue share must be a whole percent from ${MIN_SHARE_PERCENT} to ${MAX_SHARE_PERCENT}.`,
    );
  }
}

const PLAN_STATE_SELECT = {
  archivedAt: true,
  consultantProfileId: true,
} as const;

/** The plan, read after its lock. A missing plan and an archived one each refuse. */
async function readOpenPlan(db: PrismaLike, ref: PlanRef) {
  const plan =
    ref.planType === "webinar"
      ? await db.webinarPlan.findUnique({
          where: { id: ref.planId },
          select: PLAN_STATE_SELECT,
        })
      : await db.classPlan.findUnique({
          where: { id: ref.planId },
          select: PLAN_STATE_SELECT,
        });
  if (!plan) throw new CollaborationError("NOT_FOUND", "Plan not found.");
  if (plan.archivedAt) {
    throw new CollaborationError(
      "PLAN_ARCHIVED",
      "This plan is archived, so its team cannot change.",
    );
  }
  return plan;
}

type Standing =
  | { ok: true; userId: string }
  | {
      ok: false;
      reason:
        "MISSING" | "INACTIVE" | "UNVERIFIED" | "SUSPENDED" | "NOT_PAYABLE";
    };

/**
 * Whether an expert may hold a place on a team: a live, verified profile on
 * an account that is neither erased nor under an active ban, and resident in
 * India, because earnings cannot yet be paid out to a non-resident.
 */
async function readStanding(
  db: PrismaLike,
  consultantProfileId: string,
): Promise<Standing> {
  const profile = await db.consultantProfile.findUnique({
    where: { id: consultantProfileId },
    select: {
      deletedAt: true,
      verificationStatus: true,
      residencyStatus: true,
      taxInfo: { select: { isIndianResident: true } },
      user: {
        select: { id: true, banned: true, banExpires: true, erasedAt: true },
      },
    },
  });
  if (!profile) return { ok: false, reason: "MISSING" };
  if (profile.deletedAt || profile.user.erasedAt) {
    return { ok: false, reason: "INACTIVE" };
  }
  if (profile.verificationStatus !== "VERIFIED") {
    return { ok: false, reason: "UNVERIFIED" };
  }
  const banActive =
    profile.user.banned === true &&
    (!profile.user.banExpires || profile.user.banExpires > new Date());
  if (banActive) return { ok: false, reason: "SUSPENDED" };
  if (
    profile.residencyStatus === "NON_RESIDENT" ||
    profile.taxInfo?.isIndianResident === false
  ) {
    return { ok: false, reason: "NOT_PAYABLE" };
  }
  return { ok: true, userId: profile.user.id };
}

/** A collaborator cannot also hold a learner's seat on the plan they share in. */
async function assertHoldsNoSeat(
  db: PrismaLike,
  ref: PlanRef,
  userId: string,
  message: string,
): Promise<void> {
  const seat = await db.appointmentParticipant.findFirst({
    where: {
      ...liveParticipant(userId),
      role: "CONSULTEE",
      appointment: livePlanAppointmentsWhere(ref),
    },
    select: { id: true },
  });
  if (seat) throw new CollaborationError("HOLDS_A_SEAT", message);
}

/**
 * The friendly form of the limits Postgres also enforces: three live rows, one
 * presenter, shares of at most nine tenths. `excludeId` is the row being edited.
 */
async function assertTeamHasRoom(
  db: PrismaLike,
  ref: PlanRef,
  next: { role: CollaboratorRole; revenueShareBps: number },
  excludeId?: string,
): Promise<void> {
  const live = await db.collaborator.findMany({
    where: {
      ...planWhere(ref),
      status: { in: ["PENDING", "ACCEPTED"] },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { role: true, revenueShareBps: true },
  });
  if (!excludeId && live.length >= MAX_COLLABORATORS_PER_PLAN) {
    throw new CollaborationError(
      "TEAM_FULL",
      `A plan can have at most ${MAX_COLLABORATORS_PER_PLAN} invited or accepted collaborators.`,
    );
  }
  if (
    PRESENTER_ROLES.includes(next.role) &&
    live.some((c) => PRESENTER_ROLES.includes(c.role))
  ) {
    throw new CollaborationError(
      "PRESENTER_TAKEN",
      "This plan already has a co-presenter. Remove them before inviting another.",
    );
  }
  const taken = live.reduce((sum, c) => sum + c.revenueShareBps, 0);
  if (taken + next.revenueShareBps > MAX_TEAM_SHARE_BPS) {
    throw new CollaborationError(
      "SHARES_EXCEEDED",
      `Collaborators can share at most ${bpsToPercent(MAX_TEAM_SHARE_BPS)}% of a plan between them.`,
      { availablePercent: bpsToPercent(MAX_TEAM_SHARE_BPS - taken) },
    );
  }
}

/** A refusal Postgres gave after the friendly checks passed: another writer got there first. */
function asTeamConflict(error: unknown): unknown {
  if (isUniqueViolation(error)) {
    return new CollaborationError(
      "ALREADY_ON_PLAN",
      "This expert already has an invitation or a place on this plan.",
    );
  }
  if (isCheckViolation(error)) {
    return new CollaborationError(
      "CONFLICT",
      "This plan's team just changed. Reload and try again.",
    );
  }
  return error;
}

const NOT_INVITABLE = "This expert cannot be invited right now.";

export type InviteCollaboratorArgs = CollaborationTerms & {
  ref: PlanRef;
  consultantProfileId: string;
  /** The inviter's own consultant profile; null for an organisation operator who has none. */
  invitedByProfileId: string | null;
};

/**
 * Invites an expert onto a plan's team. Every invitation is a new row, so an
 * expert's earlier periods on the plan stay as they were.
 */
export async function inviteCollaborator(
  args: InviteCollaboratorArgs,
): Promise<CollaborationSummary> {
  const { ref, consultantProfileId } = args;
  assertTerms(ref, args);
  const revenueShareBps = percentToBps(args.sharePercent);

  const committed = await prisma
    .$transaction(async (tx) => {
      await lockPlanRow(tx, ref);
      const plan = await readOpenPlan(tx, ref);
      if (
        consultantProfileId === plan.consultantProfileId ||
        consultantProfileId === args.invitedByProfileId
      ) {
        throw new CollaborationError(
          "INVITEE_INELIGIBLE",
          "A plan's host cannot be its collaborator, and you cannot invite yourself.",
        );
      }
      const standing = await readStanding(tx, consultantProfileId);
      // One answer for every standing reason, so an invite tells nothing about another expert's account.
      if (!standing.ok) {
        throw new CollaborationError("INVITEE_INELIGIBLE", NOT_INVITABLE);
      }
      await assertHoldsNoSeat(
        tx,
        ref,
        standing.userId,
        "This expert has booked a seat on this plan, so they cannot also join its team.",
      );

      const earlier = await tx.collaborator.findMany({
        where: { ...planWhere(ref), consultantProfileId },
        select: { status: true, endedAt: true },
        orderBy: { createdAt: "desc" },
      });
      if (
        earlier.some((r) => r.status === "PENDING" || r.status === "ACCEPTED")
      ) {
        throw new CollaborationError(
          "ALREADY_ON_PLAN",
          "This expert already has an invitation or a place on this plan.",
        );
      }
      const lastRefusal = earlier.find(
        (r) => r.status === "DECLINED" || r.status === "WITHDRAWN",
      );
      const retryAt = lastRefusal?.endedAt
        ? reinviteAllowedAt(lastRefusal.endedAt)
        : null;
      if (retryAt && retryAt > new Date()) {
        throw new CollaborationError(
          "COOLDOWN",
          "This expert recently declined or left this plan. You can invite them again later.",
          { retryAt: retryAt.toISOString() },
        );
      }
      await assertTeamHasRoom(tx, ref, { role: args.role, revenueShareBps });

      const collaborator = await tx.collaborator.create({
        data: {
          consultantProfileId,
          ...(ref.planType === "webinar"
            ? { collaboratorType: "WEBINAR", webinarPlanId: ref.planId }
            : { collaboratorType: "CLASS", classPlanId: ref.planId }),
          role: args.role,
          tier: tierForRole(args.role),
          revenueShareBps,
          status: "PENDING",
          invitedById: args.invitedByProfileId,
        },
      });
      const notices = await stageCollaboratorNotifications(
        tx,
        "INVITED",
        collaborator,
      );
      return { collaborator, notices };
    })
    .catch((error: unknown) => {
      throw asTeamConflict(error);
    });

  await flushNotificationsAfter(committed.notices, "collaborator.invited");
  return summaryOf(committed.collaborator, ref);
}

export type UpdatePendingTermsArgs = Partial<CollaborationTerms> & {
  ref: PlanRef;
  collaboratorId: string;
};

/**
 * Changes a pending invitation's role or share and tells the invitee. Accepted
 * terms are the deal that was agreed and never change: the host removes the
 * collaborator and invites them again.
 */
export async function updatePendingTerms(
  args: UpdatePendingTermsArgs,
): Promise<CollaborationSummary> {
  const { ref, collaboratorId } = args;
  assertTerms(ref, args);

  const committed = await prisma
    .$transaction(async (tx) => {
      await lockPlanRow(tx, ref);
      const current = await tx.collaborator.findFirst({
        where: { id: collaboratorId, ...planWhere(ref) },
      });
      if (!current) {
        throw new CollaborationError(
          "NOT_FOUND",
          "This collaborator is not on this plan.",
        );
      }
      if (current.status === "ACCEPTED") {
        throw new CollaborationError(
          "TERMS_LOCKED",
          "Accepted terms cannot be changed. Remove the collaborator and invite them again with the new terms.",
        );
      }
      if (current.status !== "PENDING") {
        throw new CollaborationError(
          "NOT_PENDING",
          "This invitation is no longer open.",
        );
      }
      const role = args.role ?? current.role;
      const revenueShareBps =
        args.sharePercent === undefined
          ? current.revenueShareBps
          : percentToBps(args.sharePercent);
      if (
        role === current.role &&
        revenueShareBps === current.revenueShareBps
      ) {
        return { collaborator: current, notices: {} };
      }
      await assertTeamHasRoom(
        tx,
        ref,
        { role, revenueShareBps },
        collaboratorId,
      );

      const moved = await tx.collaborator.updateMany({
        where: { id: collaboratorId, status: "PENDING" },
        data: { role, tier: tierForRole(role), revenueShareBps },
      });
      if (moved.count === 0) {
        throw new CollaborationError(
          "NOT_PENDING",
          "This invitation is no longer open.",
        );
      }
      const collaborator = await tx.collaborator.findUniqueOrThrow({
        where: { id: collaboratorId },
      });
      const notices = await stageCollaboratorNotifications(
        tx,
        "TERMS_CHANGED",
        collaborator,
      );
      return { collaborator, notices };
    })
    .catch((error: unknown) => {
      throw asTeamConflict(error);
    });

  await flushNotificationsAfter(committed.notices, "collaborator.termsChanged");
  return summaryOf(committed.collaborator, ref);
}

type SessionWindow = { appointmentId: string; startsAt: Date; endsAt: Date };

/** The plan's sessions that occupy a calendar: what an accepting expert becomes busy at. */
function planSessionWindows(
  db: PrismaLike,
  ref: PlanRef,
): Promise<SessionWindow[]> {
  return db.appointmentOccurrence.findMany({
    where: {
      ...OCCUPYING_OCCURRENCE_WHERE,
      appointment: livePlanAppointmentsWhere(ref),
    },
    select: { appointmentId: true, startsAt: true, endsAt: true },
  });
}

const windowKey = (w: SessionWindow) =>
  `${w.startsAt.getTime()}:${w.endsAt.getTime()}`;

function sameWindows(a: SessionWindow[], b: SessionWindow[]): boolean {
  const held = new Set(a.map(windowKey));
  const now = new Set(b.map(windowKey));
  return held.size === now.size && [...now].every((k) => held.has(k));
}

const ACCEPT_REFUSALS: Record<
  Exclude<Standing, { ok: true }>["reason"],
  [CollaborationErrorCode, string]
> = {
  MISSING: ["NOT_FOUND", "Invitation not found."],
  INACTIVE: [
    "INVITEE_INELIGIBLE",
    "Your expert profile is no longer active, so you cannot accept this invitation.",
  ],
  UNVERIFIED: [
    "INVITEE_INELIGIBLE",
    "Only verified experts can join a plan's team. Finish verification, then accept.",
  ],
  SUSPENDED: [
    "INVITEE_INELIGIBLE",
    "Your account is suspended, so you cannot accept this invitation right now.",
  ],
  NOT_PAYABLE: [
    "NOT_PAYABLE",
    "Earnings cannot yet be paid to experts who are not resident in India, so this invitation cannot be accepted.",
  ],
};

export type RespondToInvitationArgs = {
  collaboratorId: string;
  /** The responding expert's own profile; the invitation must be theirs. */
  consultantProfileId: string;
  userId: string;
} & ({ response: "ACCEPTED"; seenTerms: SeenTerms } | { response: "DECLINED" });

/**
 * Accepts or declines an invitation. An accept names the terms the invitee
 * saw and applies only if the row still carries them; it holds the invitee's
 * calendar at every session of the plan across the commit.
 */
export async function respondToInvitation(
  args: RespondToInvitationArgs,
): Promise<CollaborationSummary> {
  const invitation = await prisma.collaborator.findFirst({
    where: {
      id: args.collaboratorId,
      consultantProfileId: args.consultantProfileId,
    },
    select: { webinarPlanId: true, classPlanId: true },
  });
  const planId = invitation?.webinarPlanId ?? invitation?.classPlanId;
  if (!invitation || !planId) {
    throw new CollaborationError("NOT_FOUND", "Invitation not found.");
  }
  const ref: PlanRef = {
    planType: invitation.webinarPlanId ? "webinar" : "class",
    planId,
  };
  if (args.response === "DECLINED") return declineInvitation(args, ref);
  return acceptInvitation(args, ref, args.seenTerms);
}

async function declineInvitation(
  args: RespondToInvitationArgs,
  ref: PlanRef,
): Promise<CollaborationSummary> {
  const ended = await prisma.$transaction((tx) =>
    endCollaboration(tx, {
      collaboratorId: args.collaboratorId,
      to: "DECLINED",
      endedByUserId: args.userId,
      where: { consultantProfileId: args.consultantProfileId },
    }),
  );
  if (!ended) {
    throw new CollaborationError(
      "NOT_PENDING",
      "This invitation is no longer open.",
    );
  }
  await afterCollaborationEnded(ended, "collaborator.declined");
  return summaryOf(ended.collaborator, ref);
}

/** The accept's own transaction. Every read happens after the plan lock. */
async function acceptInTx(
  tx: Tx,
  args: RespondToInvitationArgs,
  ref: PlanRef,
  seenTerms: SeenTerms,
  heldWindows: SessionWindow[],
) {
  await lockPlanRow(tx, ref);
  await readOpenPlan(tx, ref);
  const standing = await readStanding(tx, args.consultantProfileId);
  if (!standing.ok) {
    const [code, message] = ACCEPT_REFUSALS[standing.reason];
    throw new CollaborationError(code, message);
  }
  await assertHoldsNoSeat(
    tx,
    ref,
    standing.userId,
    "You have booked a seat on this plan, so you cannot also join its team.",
  );

  const windows = await planSessionWindows(tx, ref);
  if (!sameWindows(heldWindows, windows)) {
    throw new CollaborationError(
      "SCHEDULE_CHANGED",
      "This plan's schedule changed while you were accepting. Review the sessions and accept again.",
    );
  }
  if (windows.length > 0) {
    try {
      await assertConsultantAvailableForWindows(tx, {
        consultantProfileId: args.consultantProfileId,
        consultantUserId: standing.userId,
        windows,
        excludeAppointmentIds: [
          ...new Set(windows.map((w) => w.appointmentId)),
        ],
      });
    } catch (error) {
      if (error instanceof ConsultantScheduleConflictError) {
        // The detail names the plan's session; the invitee's other commitment is never described.
        throw new CollaborationError(
          "CALENDAR_CLASH",
          "One of this plan's sessions overlaps another session on your calendar.",
          error.window
            ? {
                clash: {
                  startsAt: error.window.startsAt.toISOString(),
                  endsAt: error.window.endsAt.toISOString(),
                },
              }
            : undefined,
        );
      }
      throw error;
    }
  }

  // One write checks the status, the terms and the invitation window together.
  const lapsedBefore = inviteLapsedBefore(new Date());
  const moved = await tx.collaborator.updateMany({
    where: {
      id: args.collaboratorId,
      consultantProfileId: args.consultantProfileId,
      status: "PENDING",
      role: seenTerms.role,
      revenueShareBps: percentToBps(seenTerms.sharePercent),
      updatedAt: { gte: lapsedBefore },
    },
    data: { status: "ACCEPTED" },
  });
  const collaborator = await tx.collaborator.findUniqueOrThrow({
    where: { id: args.collaboratorId },
  });
  if (moved.count === 0) {
    if (
      collaborator.status === "PENDING" &&
      collaborator.updatedAt < lapsedBefore
    ) {
      throw new CollaborationError(
        "NOT_PENDING",
        "This invitation has lapsed. Ask the host to invite you again.",
      );
    }
    if (collaborator.status === "PENDING") {
      throw new CollaborationError(
        "TERMS_CHANGED",
        "The host changed this invitation's terms. Review the new terms before accepting.",
        { terms: termsOf(collaborator) },
      );
    }
    throw new CollaborationError(
      "NOT_PENDING",
      "This invitation is no longer open.",
    );
  }
  const notices = await stageCollaboratorNotifications(
    tx,
    "ACCEPTED",
    collaborator,
  );
  return { collaborator, notices, userId: standing.userId };
}

async function acceptInvitation(
  args: RespondToInvitationArgs,
  ref: PlanRef,
  seenTerms: SeenTerms,
): Promise<CollaborationSummary> {
  const heldWindows = await planSessionWindows(prisma, ref);
  const committed = await withHostSlotBatch(
    hostBatchEntries([args.consultantProfileId], heldWindows),
    (renewHostBatch) =>
      withSerializableRetry(async () => {
        // Re-armed ahead of each attempt, outside the transaction: a lost grant writes nothing.
        await renewHostBatch();
        return prisma.$transaction(
          async (tx) => {
            await lockHostBatchInTx(
              tx,
              hostBatchEntries([args.consultantProfileId], heldWindows),
            );
            return acceptInTx(tx, args, ref, seenTerms, heldWindows);
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 10000,
          },
        );
      }),
  ).catch((error: unknown) => {
    if (error instanceof CollaborationError) throw error;
    // Only a held atom is transient; a standing clash was answered inside the transaction.
    if (error instanceof HostTimeHeldError) {
      throw new CollaborationError(
        "CALENDAR_BUSY",
        "Your calendar is being booked at one of these sessions right now. Try again in a moment.",
      );
    }
    if (isWriteConflict(error) || isDeadlock(error)) {
      throw new CollaborationError(
        "CONFLICT",
        "This plan is being changed right now. Try again in a moment.",
      );
    }
    throw asTeamConflict(error);
  });

  await flushNotificationsAfter(committed.notices, "collaborator.accepted");
  await grantCollaboratorAccess(ref, committed.userId);
  const { learnerEmails } = committed.notices;
  if (learnerEmails) {
    await sendOwedCohostEmails([learnerEmails], "collaborator.accepted");
  }
  return summaryOf(committed.collaborator, ref);
}

const NOT_ON_PLAN = "This collaborator is no longer on this plan.";

/** A manager removes an invitation or a team member from the plan. */
export async function removeCollaborator(args: {
  ref: PlanRef;
  collaboratorId: string;
  removedByUserId: string;
}): Promise<CollaborationSummary> {
  const ended = await prisma.$transaction((tx) =>
    endCollaboration(tx, {
      collaboratorId: args.collaboratorId,
      to: "REMOVED",
      endedByUserId: args.removedByUserId,
      where: planWhere(args.ref),
    }),
  );
  if (!ended) throw new CollaborationError("NOT_FOUND", NOT_ON_PLAN);
  await afterCollaborationEnded(ended, "collaborator.removed");
  return summaryOf(ended.collaborator, args.ref);
}

/**
 * A collaborator ends their own row: leaving the team is WITHDRAWN, turning
 * down an invitation they have not accepted is DECLINED.
 */
export async function leaveCollaboration(args: {
  ref: PlanRef;
  collaboratorId: string;
  consultantProfileId: string;
  userId: string;
}): Promise<CollaborationSummary> {
  const end = (tx: Tx, to: "WITHDRAWN" | "DECLINED") =>
    endCollaboration(tx, {
      collaboratorId: args.collaboratorId,
      to,
      endedByUserId: args.userId,
      where: {
        ...planWhere(args.ref),
        consultantProfileId: args.consultantProfileId,
      },
    });
  const ended: EndedCollaboration | null = await prisma.$transaction(
    async (tx) => (await end(tx, "WITHDRAWN")) ?? (await end(tx, "DECLINED")),
  );
  if (!ended) throw new CollaborationError("NOT_FOUND", NOT_ON_PLAN);
  await afterCollaborationEnded(ended, "collaborator.left");
  return summaryOf(ended.collaborator, args.ref);
}
