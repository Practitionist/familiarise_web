import * as Sentry from "@sentry/nextjs";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import prisma, { type PrismaLike, type Tx } from "@/lib/prisma";
import { Prisma, type CollaboratorRole } from "@prisma/client";
import type { Collaborator, CollaboratorStatus } from "@prisma/client";
import {
  addUserToEventChannel,
  checkEventChannelExists,
  removeUserFromEventChannel,
} from "@/lib/stream/event-channel-service";
import {
  getStreamChatClient,
  getStreamVideoClient,
  isExpectedStreamError,
} from "@/lib/stream-client";
import { CALL_MEMBER_ROLE, STREAM_CALL_TYPE } from "@/lib/stream/call-cid";
import { MAX_CALL_DURATION_MS } from "@/lib/meetings/duration-cap";
import type { RevenueSplit } from "@/types/collaborators";
import {
  WEBINAR_COLLABORATOR_ROLES,
  CLASS_COLLABORATOR_ROLES,
} from "@/schemas/collaborators";
import {
  notifyCollaboratorInvited,
  notifyCollaboratorAccepted,
  notifyCollaboratorDeclined,
  notifyCollaboratorRemoved,
  notifyCollaboratorWithdrawn,
} from "@/lib/novu/service";
import {
  sendCollaboratorInvitedEmail,
  sendCollaboratorAcceptedEmail,
  sendCollaboratorDeclinedEmail,
  sendCollaboratorRemovedEmail,
  sendCollaboratorWithdrawnEmail,
} from "@/lib/email/senders/collaborators";
import { EMAIL_BUDGET_MS } from "@/lib/email";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { getAppUrl } from "@/lib/url";
import {
  appointmentTypeLabel,
  collaboratorRoleLabel,
} from "@/lib/novu/humanize";
import { goHref } from "@/lib/dashboard/go";
import { scopeToWhereOrgId, type Scope } from "@/lib/api/scope/parse";
import { reportSentryError } from "@/lib/observability/report";
import { PRESENTER_ROLES, tierForRole } from "@/lib/collaborators/roles";
import {
  liveParticipant,
  recordParticipants,
  transitionParticipant,
} from "@/lib/booking/participants";
import {
  assertConsultantAvailableForWindows,
  ConsultantScheduleConflictError,
} from "@/lib/collaborators/availability";

// #1593 — `removeCollaboratorStanding` is deliberately NOT re-exported here:
// its callers import `@/lib/collaborators/standing` so they never load this
// module's Stream and Novu graph inside a transaction.
export {
  collaboratorUserIds,
  collaboratorUserIdsForEvent,
} from "@/lib/collaborators/recipients";

export type PlanType = "webinar" | "class";

const MIN_HOST_SHARE = 10; // Host must keep at least 10%

// #1580 §6 — at most three collaborators in PENDING + ACCEPTED per plan, and
// only one of them a co-presenter; the host stays the accountable party.
export const MAX_COLLABORATORS_PER_PLAN = 3;
export { PRESENTER_ROLES } from "@/lib/collaborators/roles";

/**
 * Sentence-start fallback when the plan row behind a bell is gone
 * ("Class", "Webinar") — never the "Unknown Plan" placeholder.
 */
const planKindLabel = (planType: string): string => {
  const label = appointmentTypeLabel(planType);
  return label.charAt(0).toUpperCase() + label.slice(1);
};

// #772 B5 — collaborator shares are stored as basis points (bps) for integer
// money math. The public API/param surface stays in percent (0–90); convert at
// the DB boundary. 30% -> 3000 bps; the 90% cap -> 9000 bps.
const pctToBps = (pct: number) => Math.round(pct * 100);
const MAX_COLLAB_BPS = (100 - MIN_HOST_SHARE) * 100; // 9000

// #784 — a Collaborator must reference exactly one plan; Postgres CHECKs
// aren't Prisma-expressible, so the XOR is enforced here.
export function assertCollaboratorPlanXor(target: {
  webinarPlanId?: string | null;
  classPlanId?: string | null;
}): void {
  if (!target.webinarPlanId === !target.classPlanId) {
    throw new Error(
      "Collaborator must reference exactly one of webinarPlanId or classPlanId (#784)",
    );
  }
}

// Maps the public planType surface to the merged model's discriminator + FK.
function planScope(planType: PlanType, planId: string) {
  const scope =
    planType === "webinar"
      ? { collaboratorType: "WEBINAR" as const, webinarPlanId: planId }
      : { collaboratorType: "CLASS" as const, classPlanId: planId };
  assertCollaboratorPlanXor(scope);
  return scope;
}

function planWhere(planType: PlanType, planId: string) {
  return planType === "webinar"
    ? { webinarPlanId: planId }
    : { classPlanId: planId };
}

// #784 — the merged DB enum can't reject a class role on a webinar collab
// (the old per-type enums did), so the subset check lives here.
const ROLES_BY_PLAN_TYPE: Record<PlanType, readonly CollaboratorRole[]> = {
  webinar: WEBINAR_COLLABORATOR_ROLES,
  class: CLASS_COLLABORATOR_ROLES,
};

function asPlanRole(planType: PlanType, role: string): CollaboratorRole | null {
  return ROLES_BY_PLAN_TYPE[planType].find((r) => r === role) ?? null;
}

/**
 * Invite a collaborator to a webinar or class plan.
 */
// #1580 — what a seat grants is its `tier`, derived from the role: a PRESENTER
// (CO_HOST / CO_INSTRUCTOR) sees the roster and holds host controls, CREW does
// not. The four per-invite capability booleans (#768) are gone with the reset;
// nothing but the roster read ever enforced one.

/** Statuses a seat cannot come back from without a fresh invite. */
const RETIRED_STATUSES: CollaboratorStatus[] = [
  "REMOVED",
  "DECLINED",
  "WITHDRAWN",
];

/** #1580 §6 — the invite transaction refuses a fourth seat or a second presenter. */
export class CollaboratorCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollaboratorCapError";
  }
}

/**
 * #1580 C-P1-9 — the invitee or the plan cannot take the seat. `httpStatus`
 * is 400 for a standing problem (deleted, unverified, banned, erased) and
 * 409 for a state clash (already an attendee, plan archived).
 */
export class CollaboratorIneligibleError extends Error {
  readonly httpStatus: 400 | 409;
  constructor(message: string, httpStatus: 400 | 409 = 400) {
    super(message);
    this.name = "CollaboratorIneligibleError";
    this.httpStatus = httpStatus;
  }
}

/**
 * The invitee must be a live, VERIFIED consultant on an account that is
 * neither banned (an expired ban does not count) nor erased. Returns the
 * user id so the caller can run the seat check without a second lookup, or
 * null when the profile does not exist at all (the pre-#1580 behaviour).
 */
async function assertInviteeEligible(
  consultantProfileId: string,
  db: PrismaLike = prisma,
): Promise<{ userId: string } | null> {
  const invitee = await db.consultantProfile.findUnique({
    where: { id: consultantProfileId },
    select: {
      deletedAt: true,
      verificationStatus: true,
      user: {
        select: { id: true, banned: true, banExpires: true, erasedAt: true },
      },
    },
  });
  if (!invitee) return null;
  if (invitee.deletedAt || invitee.user.erasedAt) {
    throw new CollaboratorIneligibleError(
      "This consultant's account is no longer active and cannot collaborate",
    );
  }
  if (invitee.verificationStatus !== "VERIFIED") {
    throw new CollaboratorIneligibleError(
      "Only verified consultants can collaborate on a plan",
    );
  }
  const banActive =
    invitee.user.banned === true &&
    (!invitee.user.banExpires || invitee.user.banExpires > new Date());
  if (banActive) {
    throw new CollaboratorIneligibleError(
      "This consultant's account is suspended and cannot collaborate",
    );
  }
  return { userId: invitee.user.id };
}

/**
 * A collaborator cannot also be an attendee of the plan they share in (the
 * checkout guard refuses the other direction, #1580 C-P0-2). The slot↔user
 * join is the seat truth; a cancelled or soft-deleted event does not count.
 */
async function assertNotAttendee(
  planType: PlanType,
  planId: string,
  userId: string,
  db: PrismaLike = prisma,
): Promise<void> {
  const appointment: Prisma.AppointmentWhereInput = livePlanAppointmentsWhere(
    planType,
    planId,
  );
  const seat = await db.appointmentParticipant.findFirst({
    where: { ...liveParticipant(userId), role: "CONSULTEE", appointment },
    select: { id: true },
  });
  if (seat) {
    throw new CollaboratorIneligibleError(
      "This consultant already holds a seat on one of this plan's events",
      409,
    );
  }
}

/** An archived (or missing) plan takes no new collaborator and accepts none. */
async function assertPlanOpen(
  planType: PlanType,
  planId: string,
  db: PrismaLike = prisma,
): Promise<void> {
  const plan =
    planType === "webinar"
      ? await db.webinarPlan.findUnique({
          where: { id: planId },
          select: { archivedAt: true },
        })
      : await db.classPlan.findUnique({
          where: { id: planId },
          select: { archivedAt: true },
        });
  if (!plan || plan.archivedAt) {
    throw new CollaboratorIneligibleError(
      "This plan is archived; collaborators cannot be invited or accepted",
      409,
    );
  }
}

async function assertInviteeAvailableForPlanEvents(
  planType: PlanType,
  planId: string,
  consultantProfileId: string,
  userId: string,
  db: PrismaLike = prisma,
): Promise<void> {
  if (typeof db.appointmentOccurrence?.findMany !== "function") return;

  const planOccurrences = await db.appointmentOccurrence.findMany({
    where: {
      deletedAt: null,
      completionStatus: { notIn: ["CANCELLED", "RESCHEDULED", "VOIDED"] },
      appointment: livePlanAppointmentsWhere(planType, planId),
    },
    select: {
      appointmentId: true,
      startsAt: true,
      endsAt: true,
    },
  });
  if (planOccurrences.length === 0) return;

  try {
    await assertConsultantAvailableForWindows(db, {
      consultantProfileId,
      consultantUserId: userId,
      windows: planOccurrences.map((o) => ({
        startsAt: o.startsAt,
        endsAt: o.endsAt,
      })),
      excludeAppointmentIds: [
        ...new Set(planOccurrences.map((o) => o.appointmentId)),
      ],
    });
  } catch (err) {
    if (err instanceof ConsultantScheduleConflictError) {
      throw new CollaboratorIneligibleError(
        "Accepting this collaboration conflicts with another session on your calendar",
        409,
      );
    }
    throw err;
  }
}

export async function inviteCollaborator(
  planType: PlanType,
  planId: string,
  consultantProfileId: string,
  role: string,
  revenueSharePercentage: number,
  invitedById: string | null = null,
): Promise<Collaborator | null> {
  if (pctToBps(revenueSharePercentage) < 1 || revenueSharePercentage > 90) {
    return null;
  }

  const planRole = asPlanRole(planType, role);
  if (!planRole) return null;

  const txResult = await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await assertPlanOpen(planType, planId, tx);
        const invitee = await assertInviteeEligible(consultantProfileId, tx);
        if (!invitee) return null;
        await assertNotAttendee(planType, planId, invitee.userId, tx);

        const valid = await validateRevenueSharesTx(
          tx,
          planType,
          planId,
          revenueSharePercentage,
        );
        if (!valid) return null;

        const existing = await tx.collaborator.findFirst({
          where: { ...planWhere(planType, planId), consultantProfileId },
        });
        if (existing && !RETIRED_STATUSES.includes(existing.status)) {
          return null;
        }

        await assertCollaboratorCapTx(tx, planType, planId, planRole);

        if (existing) {
          return tx.collaborator.update({
            where: { id: existing.id },
            data: {
              role: planRole,
              tier: tierForRole(planRole),
              revenueShareBps: pctToBps(revenueSharePercentage),
              status: "PENDING",
              invitedById,
              respondedAt: null,
            },
          });
        }

        return tx.collaborator.create({
          data: {
            consultantProfileId,
            ...planScope(planType, planId),
            role: planRole,
            tier: tierForRole(planRole),
            revenueShareBps: pctToBps(revenueSharePercentage),
            status: "PENDING",
            invitedById,
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10000,
      },
    ),
  );

  if (txResult) {
    try {
      const invitedProfile = await prisma.consultantProfile.findUnique({
        where: { id: consultantProfileId },
        select: { userId: true, user: { select: { name: true } } },
      });
      const planTitle =
        planType === "webinar"
          ? (
              await prisma.webinarPlan.findUnique({
                where: { id: planId },
                select: { title: true },
              })
            )?.title
          : (
              await prisma.classPlan.findUnique({
                where: { id: planId },
                select: { title: true },
              })
            )?.title;

      const inviterProfile = invitedById
        ? await prisma.consultantProfile.findUnique({
            where: { id: invitedById },
            select: { user: { select: { name: true } } },
          })
        : null;

      if (invitedProfile) {
        const ownerName = inviterProfile?.user?.name ?? "Plan Owner";
        const resolvedTitle = planTitle ?? planKindLabel(planType);
        await Promise.allSettled([
          notifyCollaboratorInvited(invitedProfile.userId, {
            planTitle: resolvedTitle,
            planType,
            role: collaboratorRoleLabel(role),
            revenueSharePercentage,
            ownerName,
            dashboardUrl: `${getAppUrl()}${goHref("expert", "collaborations")}`,
          }),
          sendCollaboratorInvitedEmail(
            {
              recipientUserId: invitedProfile.userId,
              actorName: ownerName,
              collaboratorName: invitedProfile.user?.name ?? "Collaborator",
              planTitle: resolvedTitle,
              planType,
              role: txResult.role,
              revenueShareBps: txResult.revenueShareBps,
              collaboratorId: txResult.id,
            },
            EMAIL_BUDGET_MS.REQUEST,
          ),
        ]);
      }
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "stream" }, level: "warning" },
      );
      console.error(
        "[collaborators] Failed to send invitation notification:",
        error,
      );
    }
  }

  return txResult;
}

async function syncOpenCallPresenterRole(
  planType: PlanType,
  planId: string,
  userId: string,
  role: CollaboratorRole,
): Promise<void> {
  try {
    const [occurrences, plan] = await Promise.all([
      prisma.appointmentOccurrence.findMany({
        where: {
          deletedAt: null,
          endsAt: { gt: new Date(Date.now() - MAX_CALL_DURATION_MS) },
          appointment: livePlanAppointmentsWhere(planType, planId),
          meeting: { is: { endedAt: null } },
        },
        select: {
          meeting: { select: { streamCallId: true } },
        },
      }),
      planType === "webinar"
        ? prisma.webinarPlan.findUnique({
            where: { id: planId },
            select: { consultantProfile: { select: { userId: true } } },
          })
        : prisma.classPlan.findUnique({
            where: { id: planId },
            select: { consultantProfile: { select: { userId: true } } },
          }),
    ]);
    if (occurrences.length === 0) return;

    const hostUserId = plan?.consultantProfile?.userId ?? userId;
    const callRole = PRESENTER_ROLES.includes(role)
      ? "co_presenter"
      : CALL_MEMBER_ROLE;
    const video = getStreamVideoClient().video;

    const results = await Promise.allSettled(
      occurrences.flatMap(({ meeting }) =>
        meeting
          ? [
              video.call(STREAM_CALL_TYPE, meeting.streamCallId).getOrCreate({
                data: {
                  created_by_id: hostUserId,
                  members: [{ user_id: userId, role: callRole }],
                },
              }),
            ]
          : [],
      ),
    );
    const failures = results.filter(
      (r): r is PromiseRejectedResult =>
        r.status === "rejected" && !isExpectedStreamError(r.reason),
    );
    if (failures.length > 0) {
      reportSentryError(failures[0].reason, {
        subsystem: "stream",
        op: "respondToInvitation.syncOpenCallRole",
        extra: {
          planId,
          planType,
          failed: failures.length,
          total: results.length,
        },
      });
    }
  } catch (error) {
    reportSentryError(error, {
      subsystem: "stream",
      op: "respondToInvitation.syncOpenCallRole",
      extra: { planId, planType },
    });
  }
}

async function runAcceptedInvitationSideEffects(
  planType: PlanType,
  planId: string,
  consultantProfileId: string,
  acceptedUserId: string | null,
  role: CollaboratorRole,
): Promise<void> {
  try {
    const plan =
      planType === "webinar"
        ? await prisma.webinarPlan.findUnique({
            where: { id: planId },
            select: { organizationId: true },
          })
        : await prisma.classPlan.findUnique({
            where: { id: planId },
            select: { organizationId: true },
          });
    const { createCollaboratorChannel } =
      await import("@/actions/stream/chat/channel.action");
    await createCollaboratorChannel(planType, planId);
    if (plan?.organizationId) {
      const customSet: Record<string, unknown> = {
        organization_id: plan.organizationId,
      };
      await getStreamChatClient()
        .channel("messaging", `collab-${planType}-${planId}`)
        .updatePartial({ set: customSet });
    }
  } catch (err) {
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "stream" }, level: "warning" },
    );
    console.error("Failed to create collaborator channel:", err);
  }

  await syncCollaboratorParticipants(planType, planId, consultantProfileId);

  if (acceptedUserId) {
    await Promise.all([
      syncAcceptedCollaboratorEventChannels(planType, planId, acceptedUserId),
      syncOpenCallPresenterRole(planType, planId, acceptedUserId, role),
    ]);
  }
}

/**
 * Respond to a collaboration invitation (accept or decline).
 * When accepted, auto-creates a collaborator Stream chat channel.
 */
export async function respondToInvitation(
  planType: PlanType,
  collaborationId: string,
  consultantProfileId: string,
  response: "ACCEPTED" | "DECLINED",
): Promise<Collaborator | null> {
  const collab = await prisma.collaborator.findUnique({
    where: { id: collaborationId },
  });
  if (!collab || collab.consultantProfileId !== consultantProfileId)
    return null;
  const planId =
    planType === "webinar" ? collab.webinarPlanId : collab.classPlanId;
  if (!planId || collab.status !== "PENDING") return null;

  let acceptedUserId: string | null = null;
  const updated = await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        if (response === "ACCEPTED") {
          await assertPlanOpen(planType, planId, tx);
          const invitee = await assertInviteeEligible(consultantProfileId, tx);
          if (!invitee) return null;
          await assertNotAttendee(planType, planId, invitee.userId, tx);
          await assertInviteeAvailableForPlanEvents(
            planType,
            planId,
            consultantProfileId,
            invitee.userId,
            tx,
          );
          acceptedUserId = invitee.userId;
        }

        const moved = await tx.collaborator.updateMany({
          where: { id: collaborationId, status: "PENDING" },
          data: { status: response, respondedAt: new Date() },
        });
        if (moved.count === 0) return null;
        return tx.collaborator.findUniqueOrThrow({
          where: { id: collaborationId },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10000,
      },
    ),
  );
  if (!updated) return null;

  if (response === "ACCEPTED") {
    await runAcceptedInvitationSideEffects(
      planType,
      planId,
      consultantProfileId,
      acceptedUserId,
      updated.role,
    );
  }

  await notifyHostOfResponse(planType, planId, consultantProfileId, updated);

  return updated;
}

function fetchActivePlanEvents(
  planType: PlanType,
  planId: string,
): Promise<{ id: string }[]> {
  const activeStatuses = ["SCHEDULED", "IN_PROGRESS", "COMPLETED"] as const;
  if (planType === "webinar") {
    if (!prisma.webinar?.findMany) return Promise.resolve([]);
    return prisma.webinar.findMany({
      where: {
        webinarPlanId: planId,
        deletedAt: null,
        status: { in: [...activeStatuses] },
      },
      select: { id: true },
    });
  }
  if (!prisma.class?.findMany) return Promise.resolve([]);
  return prisma.class.findMany({
    where: {
      classPlanId: planId,
      deletedAt: null,
      status: { in: [...activeStatuses] },
    },
    select: { id: true },
  });
}

async function syncAcceptedCollaboratorEventChannels(
  planType: PlanType,
  planId: string,
  userId: string,
): Promise<void> {
  try {
    const events = await fetchActivePlanEvents(planType, planId);

    for (const event of events) {
      if (await checkEventChannelExists(planType, event.id)) {
        await addUserToEventChannel(planType, event.id, userId);
      }
    }
  } catch (error) {
    reportSentryError(error, {
      subsystem: "collaborators",
      op: "respondToInvitation.syncEventChannels",
      level: "warning",
      extra: { planId, planType, userId },
    });
  }
}

/**
 * The plan's appointments a collaborator is party to: live, not called off.
 * An Appointment carries no status of its own; the event row does.
 */
function livePlanAppointmentsWhere(
  planType: PlanType,
  planId: string,
): Prisma.AppointmentWhereInput {
  return {
    deletedAt: null,
    ...(planType === "webinar"
      ? {
          webinar: {
            webinarPlanId: planId,
            deletedAt: null,
            status: { not: "CANCELLED" },
          },
        }
      : {
          class: {
            classPlanId: planId,
            deletedAt: null,
            status: { not: "CANCELLED" },
          },
        }),
  };
}

/**
 * Write `AppointmentParticipant(role: COLLABORATOR)` for the accepted
 * collaborator on each live appointment of the plan. Idempotent (createMany
 * skipDuplicates) and money-free: no Payment is ever linked. Best-effort —
 * the row is ACCEPTED either way and a miss is reported, not thrown.
 */
async function syncCollaboratorParticipants(
  planType: PlanType,
  planId: string,
  consultantProfileId: string,
): Promise<void> {
  try {
    const profile = await prisma.consultantProfile.findUnique({
      where: { id: consultantProfileId },
      select: { userId: true },
    });
    if (!profile) return;
    const appointments = await prisma.appointment.findMany({
      where: livePlanAppointmentsWhere(planType, planId),
      select: { id: true, organizationId: true },
    });
    if (appointments.length === 0) return;
    // One transaction, so a miss on the third appointment does not leave the
    // rest silently unsynced with nothing to re-drive it (#1593).
    await prisma.$transaction(async (tx) => {
      for (const appointment of appointments) {
        await recordParticipants(
          tx,
          appointment.id,
          [
            {
              userId: profile.userId,
              role: "COLLABORATOR",
              status: "CONFIRMED",
            },
          ],
          { organizationId: appointment.organizationId },
        );
      }
      // `recordParticipants` skips a row that already exists, so a collaborator
      // removed and accepted again kept a CANCELLED seat (#1580 §3 E2E).
      // #1846 SM-B9 — the revive widens the map's from-set explicitly.
      await transitionParticipant(
        tx,
        {
          appointmentId: { in: appointments.map((a) => a.id) },
          userId: profile.userId,
          role: "COLLABORATOR",
        },
        "CONFIRMED",
        { fromIn: ["CANCELLED"] },
      );
    });
  } catch (error) {
    reportSentryError(error, {
      subsystem: "collaborators",
      op: "respondToInvitation.syncParticipants",
      extra: { planId, planType },
    });
  }
}

async function notifyHostOfResponse(
  planType: PlanType,
  planId: string,
  consultantProfileId: string,
  updated: Collaborator,
): Promise<void> {
  try {
    const plan =
      planType === "webinar"
        ? await prisma.webinarPlan.findUnique({
            where: { id: planId },
            select: {
              title: true,
              consultantProfile: { select: { userId: true } },
            },
          })
        : await prisma.classPlan.findUnique({
            where: { id: planId },
            select: {
              title: true,
              consultantProfile: { select: { userId: true } },
            },
          });
    const [collabProfile, inviterProfile] = await Promise.all([
      prisma.consultantProfile.findUnique({
        where: { id: consultantProfileId },
        select: { user: { select: { name: true } } },
      }),
      updated.invitedById
        ? prisma.consultantProfile.findUnique({
            where: { id: updated.invitedById },
            select: { userId: true },
          })
        : Promise.resolve(null),
    ]);
    const hostUserId =
      plan?.consultantProfile?.userId ?? inviterProfile?.userId ?? null;
    if (!hostUserId) return;
    const planTitle = plan?.title ?? planKindLabel(planType);
    const collaboratorName = collabProfile?.user?.name ?? "A collaborator";
    const payload = {
      planTitle,
      planType,
      collaboratorName,
      role: collaboratorRoleLabel(updated.role),
      dashboardUrl: `${getAppUrl()}${goHref("expert", "collaborations")}`,
    };
    const emailPayload = {
      recipientUserId: hostUserId,
      actorName: collaboratorName,
      collaboratorName,
      planTitle,
      planType,
      role: updated.role,
      revenueShareBps: updated.revenueShareBps,
      collaboratorId: updated.id,
    };
    if (updated.status === "ACCEPTED") {
      await Promise.allSettled([
        notifyCollaboratorAccepted(hostUserId, payload),
        sendCollaboratorAcceptedEmail(emailPayload, EMAIL_BUDGET_MS.REQUEST),
      ]);
    } else {
      await Promise.allSettled([
        notifyCollaboratorDeclined(hostUserId, payload),
        sendCollaboratorDeclinedEmail(emailPayload, EMAIL_BUDGET_MS.REQUEST),
      ]);
    }
  } catch (error) {
    reportSentryError(error, {
      subsystem: "collaborators",
      op: "respondToInvitation.notifyHost",
      level: "warning",
      extra: { planId, planType },
    });
    console.error(
      "[collaborators] Failed to send response notification:",
      error,
    );
  }
}

export type RemovedCollaborator = Collaborator & { accessRevoked: boolean };

export async function removeCollaborator(
  planType: PlanType,
  collaborationId: string,
  planId: string,
  opts: { withdrawnByProfileId?: string } = {},
): Promise<RemovedCollaborator | null> {
  const collab = await prisma.collaborator.findFirst({
    where: {
      id: collaborationId,
      ...planWhere(planType, planId),
      ...(opts.withdrawnByProfileId
        ? {
            consultantProfileId: opts.withdrawnByProfileId,
            status: { in: ["PENDING", "ACCEPTED"] },
          }
        : {}),
    },
  });
  if (!collab) return null;

  const moved = await prisma.collaborator.updateMany({
    where: { id: collaborationId, status: { in: ["PENDING", "ACCEPTED"] } },
    data: { status: opts.withdrawnByProfileId ? "WITHDRAWN" : "REMOVED" },
  });
  if (moved.count === 0) return null;
  const result = await prisma.collaborator.findUniqueOrThrow({
    where: { id: collaborationId },
  });

  const profile = await prisma.consultantProfile
    .findUnique({
      where: { id: collab.consultantProfileId },
      select: { userId: true, user: { select: { name: true } } },
    })
    .catch((error) => {
      reportSentryError(error, {
        subsystem: "collaborators",
        op: "removeCollaborator.profileLookup",
        expected: false,
      });
      return null;
    });

  const withdrawn = Boolean(opts.withdrawnByProfileId);

  let accessRevoked = false;
  if (profile?.userId) {
    accessRevoked = (
      await revokeCollaboratorAccess(planType, planId, profile.userId, {
        notify: !withdrawn,
      })
    ).success;
  }

  if (!withdrawn && profile?.userId) {
    try {
      const plan =
        planType === "webinar"
          ? await prisma.webinarPlan.findUnique({
              where: { id: planId },
              select: {
                title: true,
                consultantProfile: {
                  select: { user: { select: { name: true } } },
                },
              },
            })
          : await prisma.classPlan.findUnique({
              where: { id: planId },
              select: {
                title: true,
                consultantProfile: {
                  select: { user: { select: { name: true } } },
                },
              },
            });
      await sendCollaboratorRemovedEmail(
        {
          recipientUserId: profile.userId,
          actorName: plan?.consultantProfile?.user?.name ?? "Plan Owner",
          collaboratorName: profile.user?.name ?? "Collaborator",
          planTitle: plan?.title ?? planKindLabel(planType),
          planType,
          role: result.role,
          revenueShareBps: result.revenueShareBps,
          collaboratorId: result.id,
        },
        EMAIL_BUDGET_MS.REQUEST,
      );
    } catch (error) {
      reportSentryError(error, {
        subsystem: "collaborators",
        op: "removeCollaborator.sendEmail",
        level: "warning",
        extra: { planId, planType },
      });
    }
  }

  if (withdrawn) {
    await notifyHostOfWithdrawal(
      planType,
      planId,
      profile?.user?.name ?? "A collaborator",
      result,
    );
  }

  return { ...result, accessRevoked };
}

async function notifyHostOfWithdrawal(
  planType: PlanType,
  planId: string,
  collaboratorName: string,
  collaborator: Collaborator,
): Promise<void> {
  try {
    const plan =
      planType === "webinar"
        ? await prisma.webinarPlan.findUnique({
            where: { id: planId },
            select: {
              title: true,
              consultantProfile: { select: { userId: true } },
            },
          })
        : await prisma.classPlan.findUnique({
            where: { id: planId },
            select: {
              title: true,
              consultantProfile: { select: { userId: true } },
            },
          });
    const inviterProfile = collaborator.invitedById
      ? await prisma.consultantProfile.findUnique({
          where: { id: collaborator.invitedById },
          select: { userId: true },
        })
      : null;
    const hostUserId =
      plan?.consultantProfile?.userId ?? inviterProfile?.userId ?? null;
    if (!hostUserId) return;
    const planTitle = plan?.title ?? planKindLabel(planType);
    await Promise.allSettled([
      notifyCollaboratorWithdrawn(hostUserId, {
        planTitle,
        planType,
        collaboratorName,
        dashboardUrl: `${getAppUrl()}${goHref("expert", "collaborations")}`,
      }),
      sendCollaboratorWithdrawnEmail(
        {
          recipientUserId: hostUserId,
          actorName: collaboratorName,
          collaboratorName,
          planTitle,
          planType,
          role: collaborator.role,
          revenueShareBps: collaborator.revenueShareBps,
          collaboratorId: collaborator.id,
        },
        EMAIL_BUDGET_MS.REQUEST,
      ),
    ]);
  } catch (error) {
    reportSentryError(error, {
      subsystem: "collaborators",
      op: "removeCollaborator.notifyHostOfWithdrawal",
      extra: { planId, planType },
    });
  }
}

export async function revokeCollaboratorAccess(
  planType: PlanType,
  planId: string,
  userId: string,
  opts: { notify?: boolean } = {},
): Promise<{ success: boolean }> {
  let success = true;

  if (opts.notify ?? true) {
    try {
      const plan =
        planType === "webinar"
          ? await prisma.webinarPlan.findUnique({
              where: { id: planId },
              select: { title: true },
            })
          : await prisma.classPlan.findUnique({
              where: { id: planId },
              select: { title: true },
            });
      await notifyCollaboratorRemoved(userId, {
        planTitle: plan?.title ?? planKindLabel(planType),
        planType,
        dashboardUrl: `${getAppUrl()}${goHref("expert", "collaborations")}`,
      });
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "stream" }, level: "warning" },
      );
      console.error(
        "[collaborators] Failed to send removal notification:",
        error,
      );
    }
  }

  try {
    await transitionParticipant(
      prisma,
      {
        userId,
        role: "COLLABORATOR",
        status: { not: "CANCELLED" },
        appointment: livePlanAppointmentsWhere(planType, planId),
      },
      "CANCELLED",
    );
  } catch (error) {
    success = false;
    reportSentryError(error, {
      subsystem: "collaborators",
      op: "revokeCollaboratorAccess.participants",
      extra: { planId, planType },
    });
  }

  try {
    const events =
      planType === "webinar"
        ? await prisma.webinar.findMany({
            where: { webinarPlanId: planId },
            select: { id: true },
          })
        : await prisma.class.findMany({
            where: { classPlanId: planId },
            select: { id: true },
          });
    const revocations = await Promise.all(
      events.map((event) =>
        removeUserFromEventChannel(planType, event.id, userId),
      ),
    );
    const failedEventIds = events
      .filter((_, i) => !revocations[i]?.success)
      .map((event) => event.id);
    if (failedEventIds.length > 0) {
      success = false;
      reportSentryError(
        new Error(
          `Chat access not revoked for ${failedEventIds.length} of ${events.length} ${planType} events`,
        ),
        {
          subsystem: "stream",
          op: "removeCollaborator.revokeEventChannels",
          extra: { planId, planType, failedEventIds },
        },
      );
    }
    await getStreamChatClient()
      .channel("messaging", `collab-${planType}-${planId}`)
      .removeMembers([userId])
      .catch((error) => {
        if (isExpectedStreamError(error)) return;
        success = false;
        reportSentryError(error, {
          subsystem: "stream",
          op: "removeCollaborator.revokeCollabChannel",
          extra: { planId, planType },
        });
      });
  } catch (error) {
    success = false;
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" }, level: "warning" },
    );
    console.error("[collaborators] Failed to revoke Stream access:", error);
  }

  if (!(await revokeOpenCallPresenterRole(planType, planId, userId))) {
    success = false;
  }

  return { success };
}

async function revokeOpenCallPresenterRole(
  planType: PlanType,
  planId: string,
  userId: string,
): Promise<boolean> {
  try {
    const occurrences = await prisma.appointmentOccurrence.findMany({
      where: {
        deletedAt: null,
        endsAt: { gt: new Date(Date.now() - MAX_CALL_DURATION_MS) },
        appointment: livePlanAppointmentsWhere(planType, planId),
        meeting: { is: { endedAt: null } },
      },
      select: {
        appointmentId: true,
        meeting: { select: { streamCallId: true } },
      },
    });
    if (occurrences.length === 0) return true;

    const seats = await prisma.appointmentParticipant.findMany({
      where: {
        ...liveParticipant(userId),
        role: { not: "COLLABORATOR" },
        appointmentId: { in: occurrences.map((o) => o.appointmentId) },
      },
      select: { appointmentId: true },
    });
    const seated = new Set(seats.map((seat) => seat.appointmentId));

    const video = getStreamVideoClient().video;
    const results = await Promise.allSettled(
      occurrences.flatMap(({ appointmentId, meeting }) => {
        if (!meeting) return [];
        const call = video.call(STREAM_CALL_TYPE, meeting.streamCallId);
        return [
          (async () => {
            await call.updateCallMembers(
              seated.has(appointmentId)
                ? {
                    update_members: [
                      { user_id: userId, role: CALL_MEMBER_ROLE },
                    ],
                  }
                : { remove_members: [userId] },
            );
            if (!seated.has(appointmentId)) {
              await call.updateUserPermissions({
                user_id: userId,
                revoke_permissions: ["send-audio", "send-video", "screenshare"],
              });
              await call.kickUser({ user_id: userId });
            }
          })(),
        ];
      }),
    );
    const failures = results.filter(
      (r): r is PromiseRejectedResult =>
        r.status === "rejected" && !isExpectedStreamError(r.reason),
    );
    if (failures.length === 0) return true;
    reportSentryError(failures[0].reason, {
      subsystem: "stream",
      op: "removeCollaborator.revokeCallRole",
      extra: {
        planId,
        planType,
        failed: failures.length,
        total: results.length,
      },
    });
    return false;
  } catch (error) {
    reportSentryError(error, {
      subsystem: "stream",
      op: "removeCollaborator.revokeCallRole",
      extra: { planId, planType },
    });
    return false;
  }
}

/**
 * #1580 C-P0-3 — an ACCEPTED row's terms are the deal the collaborator agreed
 * to. Flipping it back to PENDING for re-consent would drop them from every
 * ACCEPTED-only reader and pay their share to the host in that window, so a
 * change is refused; the host removes and re-invites with the new terms.
 */
export class CollaboratorTermsLockedError extends Error {
  constructor() {
    super(
      "Accepted terms cannot be changed; remove the collaborator and re-invite with the new terms",
    );
    this.name = "CollaboratorTermsLockedError";
  }
}

/** The row is missing from the plan, or already REMOVED / DECLINED (→ 404). */
export class CollaboratorNotFoundError extends Error {
  constructor() {
    super("Collaborator not found or no longer active on this plan");
    this.name = "CollaboratorNotFoundError";
  }
}

/**
 * Update a PENDING collaborator's revenue share or role.
 * Requires planId to prevent IDOR — ensures the collaborator belongs to the specified plan.
 * Returns null when the new terms fail validation (as before); throws
 * CollaboratorNotFoundError for a missing / REMOVED / DECLINED row and
 * CollaboratorTermsLockedError for an ACCEPTED one (#1580 C-P0-3).
 */
export async function updateCollaborator(
  planType: PlanType,
  collaborationId: string,
  planId: string,
  updates: { revenueSharePercentage?: number; role?: string },
): Promise<Collaborator | null> {
  // Validate percentage range if updating
  if (updates.revenueSharePercentage !== undefined) {
    if (
      pctToBps(updates.revenueSharePercentage) < 1 ||
      updates.revenueSharePercentage > 90
    ) {
      return null;
    }
  }

  // #784 — reject cross-type roles up front (the per-type DB enums used to).
  let planRole: CollaboratorRole | undefined;
  if (updates.role) {
    const matched = asPlanRole(planType, updates.role);
    if (!matched) return null;
    planRole = matched;
  }

  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        // Verify collaborator belongs to this plan (IDOR prevention)
        const collab = await tx.collaborator.findFirst({
          where: { id: collaborationId, ...planWhere(planType, planId) },
        });
        if (!collab) throw new CollaboratorNotFoundError();
        // A share change during re-consent would drop the collaborator from
        // every ACCEPTED-only reader and pay their share to the host (#1580).
        if (collab.status === "ACCEPTED")
          throw new CollaboratorTermsLockedError();
        if (collab.status !== "PENDING") throw new CollaboratorNotFoundError();

        // A re-role to a presenter is the same guarantee as inviting one.
        if (planRole && PRESENTER_ROLES.includes(planRole)) {
          await assertCollaboratorCapTx(
            tx,
            planType,
            planId,
            planRole,
            collaborationId,
          );
        }

        if (updates.revenueSharePercentage !== undefined) {
          const valid = await validateRevenueSharesTx(
            tx,
            planType,
            planId,
            updates.revenueSharePercentage,
            collaborationId,
          );
          if (!valid) return null;
        }

        return tx.collaborator.update({
          where: { id: collaborationId },
          data: {
            ...(updates.revenueSharePercentage !== undefined && {
              revenueShareBps: pctToBps(updates.revenueSharePercentage),
            }),
            ...(planRole && { role: planRole, tier: tierForRole(planRole) }),
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10000,
      },
    ),
  );
}

/**
 * Get all collaborators for a plan. `db` lets a caller inside an open
 * transaction read through it instead of the global client (#1580 C-P0-1).
 */
export async function getCollaborators(
  planType: PlanType,
  planId: string,
  db: PrismaLike = prisma,
) {
  const activeStatuses: CollaboratorStatus[] = ["PENDING", "ACCEPTED"];

  return db.collaborator.findMany({
    where: {
      ...planWhere(planType, planId),
      status: { in: activeStatuses },
      consultantProfile: { deletedAt: null },
    },
    include: {
      consultantProfile: {
        include: { user: { select: { name: true, image: true } } },
      },
    },
    orderBy: { createdAt: "asc" },
  });
}

type CollaboratorItem = Awaited<ReturnType<typeof getCollaborators>>[number];

export type CollaboratorAuthResult =
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "ok"; data: CollaboratorItem[] };

/**
 * Fetch collaborators for a plan and apply visibility scoping based on the
 * requesting user's role (owner / accepted collaborator / pending invitee).
 * Returns a discriminated union so HTTP concerns stay in the route layer.
 */
export async function getCollaboratorsForUser(
  planType: PlanType,
  planId: string,
  userId: string,
): Promise<CollaboratorAuthResult> {
  const planQuery =
    planType === "webinar"
      ? prisma.webinarPlan.findUnique({
          where: { id: planId },
          select: { consultantProfileId: true, organizationId: true },
        })
      : prisma.classPlan.findUnique({
          where: { id: planId },
          select: { consultantProfileId: true, organizationId: true },
        });

  const [plan, requesterProfile] = await Promise.all([
    planQuery,
    prisma.consultantProfile.findFirst({
      where: { userId },
      select: { id: true },
    }),
  ]);

  if (!plan) return { status: "not_found" };

  const requesterProfileId = requesterProfile?.id;
  const isOwner =
    Boolean(requesterProfileId) &&
    plan.consultantProfileId === requesterProfileId;

  let isOrgCatalogManager = false;
  if (!isOwner && plan.organizationId) {
    const row = await prisma.membership.findFirst({
      where: {
        userId,
        organizationId: plan.organizationId,
        status: "ACTIVE",
      },
      select: { role: true, organization: { select: { status: true } } },
    });
    if (
      row &&
      row.organization.status !== "DEACTIVATED" &&
      hasOrgPermission(row.role, "catalog.manage")
    ) {
      isOrgCatalogManager = true;
    }
  }

  if (!requesterProfileId && !isOrgCatalogManager) {
    return { status: "forbidden" };
  }

  const collaborators = await getCollaborators(planType, planId);

  if (isOwner || isOrgCatalogManager) {
    return { status: "ok", data: collaborators };
  }

  const ownRecord = collaborators.find(
    (c) => c.consultantProfileId === requesterProfileId,
  );

  if (ownRecord?.status === "ACCEPTED") {
    return {
      status: "ok",
      data: collaborators
        .filter((c) => c.status === "ACCEPTED")
        .map((c) => ({
          ...c,
          revenueShareBps:
            c.consultantProfileId === requesterProfileId
              ? c.revenueShareBps
              : 0,
        })),
    };
  }

  if (ownRecord?.status === "PENDING") {
    return { status: "ok", data: [ownRecord] };
  }

  return { status: "forbidden" };
}

export async function getMyCollaborations(consultantProfileId: string) {
  const [webinarCollabs, classCollabs, verifiedPayoutAccount] =
    await Promise.all([
      prisma.collaborator.findMany({
        where: {
          consultantProfileId,
          collaboratorType: "WEBINAR",
          status: { in: ["PENDING", "ACCEPTED"] },
          webinarPlan: { archivedAt: null },
        },
        include: {
          webinarPlan: {
            select: {
              id: true,
              title: true,
              price: true,
              durationInHours: true,
              maxParticipants: true,
              language: true,
              level: true,
              consultantProfile: {
                select: {
                  id: true,
                  user: { select: { name: true, image: true } },
                },
              },
              collaborators: {
                where: { status: { in: ["PENDING", "ACCEPTED"] } },
                select: {
                  id: true,
                  role: true,
                  revenueShareBps: true,
                  status: true,
                  consultantProfile: {
                    select: {
                      id: true,
                      user: { select: { name: true, image: true } },
                    },
                  },
                },
                orderBy: { createdAt: "asc" },
              },
              webinars: {
                where: { status: { in: ["SCHEDULED", "IN_PROGRESS"] } },
                include: {
                  appointment: {
                    include: {
                      _count: {
                        select: {
                          participants: {
                            where: { ...liveParticipant(), role: "CONSULTEE" },
                          },
                        },
                      },
                      occurrences: {
                        select: {
                          startsAt: true,
                          endsAt: true,
                          isTentative: true,
                        },
                      },
                    },
                  },
                },
                orderBy: { createdAt: "desc" },
                take: 5,
              },
            },
          },
          invitedBy: {
            include: { user: { select: { name: true } } },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.collaborator.findMany({
        where: {
          consultantProfileId,
          collaboratorType: "CLASS",
          status: { in: ["PENDING", "ACCEPTED"] },
          classPlan: { archivedAt: null },
        },
        include: {
          classPlan: {
            select: {
              id: true,
              title: true,
              price: true,
              sessionDurationInHours: true,
              maxParticipants: true,
              sessionsPerWeek: true,
              durationInMonths: true,
              totalSessions: true,
              lateJoinUntilSession: true,
              consultantProfile: {
                select: {
                  id: true,
                  user: { select: { name: true, image: true } },
                },
              },
              collaborators: {
                where: { status: { in: ["PENDING", "ACCEPTED"] } },
                select: {
                  id: true,
                  role: true,
                  revenueShareBps: true,
                  status: true,
                  consultantProfile: {
                    select: {
                      id: true,
                      user: { select: { name: true, image: true } },
                    },
                  },
                },
                orderBy: { createdAt: "asc" },
              },
              classes: {
                where: { status: { in: ["SCHEDULED", "IN_PROGRESS"] } },
                include: {
                  appointment: {
                    include: {
                      _count: {
                        select: {
                          participants: {
                            where: { ...liveParticipant(), role: "CONSULTEE" },
                          },
                        },
                      },
                      occurrences: {
                        select: {
                          startsAt: true,
                          endsAt: true,
                          isTentative: true,
                          ordinal: true,
                          completionStatus: true,
                          deletedAt: true,
                        },
                        orderBy: { startsAt: "asc" },
                      },
                    },
                  },
                },
                orderBy: { createdAt: "desc" },
                take: 5,
              },
            },
          },
          invitedBy: {
            include: { user: { select: { name: true } } },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.payoutAccount.findFirst({
        where: { consultantProfileId, isVerified: true },
        select: { id: true },
      }),
    ]);

  const payoutAccountReady = Boolean(verifiedPayoutAccount);

  return {
    webinarCollaborations: webinarCollabs.map((collab) => {
      const isPlanOwner =
        collab.webinarPlan?.consultantProfile?.id === consultantProfileId;
      return {
        ...collab,
        payoutAccountReady,
        webinarPlan: collab.webinarPlan
          ? {
              ...collab.webinarPlan,
              collaborators: collab.webinarPlan.collaborators
                .filter(
                  (peer) =>
                    isPlanOwner ||
                    peer.status === "ACCEPTED" ||
                    peer.consultantProfile.id === consultantProfileId,
                )
                .map((peer) => ({
                  ...peer,
                  revenueShareBps:
                    isPlanOwner ||
                    peer.consultantProfile.id === consultantProfileId
                      ? peer.revenueShareBps
                      : 0,
                })),
            }
          : null,
      };
    }),
    classCollaborations: classCollabs.map((collab) => {
      const isPlanOwner =
        collab.classPlan?.consultantProfile?.id === consultantProfileId;
      return {
        ...collab,
        payoutAccountReady,
        classPlan: collab.classPlan
          ? {
              ...collab.classPlan,
              collaborators: collab.classPlan.collaborators
                .filter(
                  (peer) =>
                    isPlanOwner ||
                    peer.status === "ACCEPTED" ||
                    peer.consultantProfile.id === consultantProfileId,
                )
                .map((peer) => ({
                  ...peer,
                  revenueShareBps:
                    isPlanOwner ||
                    peer.consultantProfile.id === consultantProfileId
                      ? peer.revenueShareBps
                      : 0,
                })),
            }
          : null,
      };
    }),
  };
}

export async function getHostedCollaborations(
  consultantProfileId: string,
  scope: Scope = { kind: "personal" },
) {
  return hostedCollaborationsWhere({
    consultantProfileId,
    ...scopeToWhereOrgId(scope),
  });
}

export async function getOrgHostedCollaborations(organizationId: string) {
  return hostedCollaborationsWhere({ organizationId });
}

async function hostedCollaborationsWhere(
  planFilter:
    | { consultantProfileId: string; organizationId?: string | null }
    | { organizationId: string },
) {
  const [webinarPlans, classPlans] = await Promise.all([
    prisma.webinarPlan.findMany({
      where: {
        ...planFilter,
        archivedAt: null,
        collaborators: {
          some: { status: { in: ["PENDING", "ACCEPTED"] } },
        },
      },
      select: {
        id: true,
        title: true,
        price: true,
        durationInHours: true,
        maxParticipants: true,
        language: true,
        level: true,
        consultantProfile: {
          select: { user: { select: { name: true, image: true } } },
        },
        collaborators: {
          where: { status: { in: ["PENDING", "ACCEPTED"] } },
          include: {
            consultantProfile: {
              include: { user: { select: { name: true, image: true } } },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        webinars: {
          where: { status: { in: ["SCHEDULED", "IN_PROGRESS"] } },
          include: {
            appointment: {
              include: {
                _count: {
                  select: {
                    participants: {
                      where: { ...liveParticipant(), role: "CONSULTEE" },
                    },
                  },
                },
                occurrences: {
                  select: {
                    startsAt: true,
                    endsAt: true,
                    isTentative: true,
                  },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.classPlan.findMany({
      where: {
        ...planFilter,
        archivedAt: null,
        collaborators: {
          some: { status: { in: ["PENDING", "ACCEPTED"] } },
        },
      },
      select: {
        id: true,
        title: true,
        price: true,
        sessionDurationInHours: true,
        maxParticipants: true,
        sessionsPerWeek: true,
        durationInMonths: true,
        totalSessions: true,
        lateJoinUntilSession: true,
        consultantProfile: {
          select: { user: { select: { name: true, image: true } } },
        },
        collaborators: {
          where: { status: { in: ["PENDING", "ACCEPTED"] } },
          include: {
            consultantProfile: {
              include: { user: { select: { name: true, image: true } } },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        classes: {
          where: { status: { in: ["SCHEDULED", "IN_PROGRESS"] } },
          include: {
            appointment: {
              include: {
                _count: {
                  select: {
                    participants: {
                      where: { ...liveParticipant(), role: "CONSULTEE" },
                    },
                  },
                },
                occurrences: {
                  select: {
                    startsAt: true,
                    endsAt: true,
                    isTentative: true,
                    ordinal: true,
                    completionStatus: true,
                    deletedAt: true,
                  },
                  orderBy: { startsAt: "asc" },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return { webinarPlans, classPlans };
}

async function assertCollaboratorCapTx(
  db: PrismaLike,
  planType: PlanType,
  planId: string,
  role: CollaboratorRole,
  excludeId?: string,
): Promise<void> {
  const active = await db.collaborator.findMany({
    where: {
      ...planWhere(planType, planId),
      status: { in: ["PENDING", "ACCEPTED"] },
      consultantProfile: { deletedAt: null },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { role: true },
  });
  if (!excludeId && active.length >= MAX_COLLABORATORS_PER_PLAN) {
    throw new CollaboratorCapError(
      `A plan can have at most ${MAX_COLLABORATORS_PER_PLAN} pending or accepted collaborators`,
    );
  }
  if (
    PRESENTER_ROLES.includes(role) &&
    active.some((c) => PRESENTER_ROLES.includes(c.role))
  ) {
    throw new CollaboratorCapError(
      "A plan can have only one co-presenter (CO_HOST or CO_INSTRUCTOR); remove the existing one first",
    );
  }
}

async function validateRevenueSharesTx(
  db: Tx | typeof prisma,
  planType: PlanType,
  planId: string,
  newShare: number,
  excludeId?: string,
): Promise<boolean> {
  const collabs = await db.collaborator.findMany({
    where: {
      ...planWhere(planType, planId),
      status: { in: ["PENDING", "ACCEPTED"] },
      consultantProfile: { deletedAt: null },
      ...(excludeId && { NOT: { id: excludeId } }),
    },
    select: { revenueShareBps: true },
  });
  const currentTotal = collabs.reduce((sum, c) => sum + c.revenueShareBps, 0);

  return currentTotal + pctToBps(newShare) <= MAX_COLLAB_BPS;
}

export async function calculateRevenueSplit(
  planType: PlanType,
  planId: string,
  totalAmount: number,
  db: PrismaLike = prisma,
  opts: { excludeBuyerUserId?: string } = {},
): Promise<RevenueSplit[]> {
  const collabs = await getCollaborators(planType, planId, db);
  const acceptedCollabs = collabs.filter(
    (c) =>
      c.status === "ACCEPTED" &&
      c.consultantProfile.userId !== opts.excludeBuyerUserId,
  );

  if (acceptedCollabs.length === 0) {
    return [];
  }

  const splits: RevenueSplit[] = [];

  const bpsSum = acceptedCollabs.reduce((a, c) => a + c.revenueShareBps, 0);
  if (bpsSum > MAX_COLLAB_BPS) {
    throw new Error(
      `calculateRevenueSplit: collaborator shares sum to ${bpsSum} bps (> ${MAX_COLLAB_BPS}) on ${planType} plan ${planId}`,
    );
  }
  let collaboratorTotal = 0;
  for (const collab of acceptedCollabs) {
    const share = Math.floor((totalAmount * collab.revenueShareBps) / 10_000);
    collaboratorTotal += share;
    splits.push({
      consultantProfileId: collab.consultantProfileId,
      share,
      role: collab.role,
    });
  }

  const ownerShare = totalAmount - collaboratorTotal;

  let ownerConsultantProfileId: string | null = null;
  let ownerOrganizationId: string | null = null;
  if (planType === "webinar") {
    const plan = await db.webinarPlan.findUnique({
      where: { id: planId },
      select: { consultantProfileId: true, organizationId: true },
    });
    ownerConsultantProfileId = plan?.consultantProfileId ?? null;
    ownerOrganizationId = plan?.organizationId ?? null;
  } else {
    const plan = await db.classPlan.findUnique({
      where: { id: planId },
      select: { consultantProfileId: true, organizationId: true },
    });
    ownerConsultantProfileId = plan?.consultantProfileId ?? null;
    ownerOrganizationId = plan?.organizationId ?? null;
  }

  if (ownerConsultantProfileId || ownerOrganizationId) {
    splits.unshift({
      consultantProfileId: ownerConsultantProfileId,
      organizationId: ownerOrganizationId,
      share: ownerShare,
      role: "OWNER",
    });
  }

  return splits;
}
