import { revokeMemberStreamAccess } from "@/lib/stream/org-access-revocation";
import * as Sentry from "@sentry/nextjs";
import { Prisma } from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { MEMBER_ROLE_LABEL } from "@/lib/labels/org-labels";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";
import { transitionMembership } from "@/lib/enterprise/transitions";
import { revokeOrgManagedUserSessions } from "@/lib/sso/session-sweeps";
import {
  stampSessionEnds,
  type EndedSessions,
} from "@/lib/auth/session-access-log";
import {
  assertNotLastOwner,
  assertRemovable,
  countRemovalObligations,
  MembershipGuardError,
  type GuardedMembership,
  type RemovalObligations,
} from "@/lib/enterprise/membership-guards";
import { releaseSeatsForTerminatedAssignments } from "@/lib/api/organizations/seat-count";
import { recomputeConsultantIsIndependent } from "@/lib/api/organizations/membership-transitions";
import { notifyOrgExpertRemoved } from "@/lib/novu/service";
import { notifyOrgMemberRemoved } from "@/lib/novu/org-workflows";
import { attemptTrigger, type StagedTrigger } from "@/lib/novu";
import type { OrgExpertRemovedPayload } from "@/lib/novu/workflows";
import { goHref } from "@/lib/dashboard/go";
import {
  attemptOnboardingEmail,
  stageOrgMembershipChangedEmail,
  type StagedOnboardingEmail,
} from "@/lib/email";
import { scheduleAfter } from "@/lib/api/after-safe";
import {
  afterCollaborationEnded,
  endCollaboration,
  type EndedCollaboration,
} from "@/lib/collaborators/ending";
import { enqueueOrgMemberRevocationRetry } from "@/lib/stream/access-revocation";
import { getAppUrl } from "@/lib/url";

export interface RemoveMemberInput {
  orgId: string;
  memberId: string;
  actor:
    | { membershipId: string; role: GuardedMembership["role"] }
    | { kind: "self"; membershipId: string; role: GuardedMembership["role"] };
  actorUserId: string;
  force: boolean;
  releaseActiveSeats?: boolean;
}

export type RemoveMemberResult = { removed: boolean };

interface PostCommit {
  removedUserId: string | null;
  expertNotice: { userId: string; payload: OrgExpertRemovedPayload } | null;
  memberBells: StagedTrigger[];
  email: StagedOnboardingEmail | null;
  /** The member's collaborations on this organisation's plans, ended with the removal. */
  endedCollaborations: EndedCollaboration[];
  endedSessions: EndedSessions[];
}

async function validateSelfLeaveObligations(
  tx: Tx,
  current: GuardedMembership & { id: string; userId: string },
  input: RemoveMemberInput,
  now: Date,
): Promise<RemovalObligations> {
  if (
    input.actor.membershipId !== input.memberId ||
    current.userId !== input.actorUserId
  ) {
    throw Object.assign(new Error("Cannot leave on behalf of another member"), {
      httpStatus: 403,
    });
  }
  if (current.role === "OWNER" && current.status === "ACTIVE") {
    await assertNotLastOwner(tx, input.orgId, input.memberId);
  }
  const rawObligations = await countRemovalObligations(tx, current, now);
  const obligations = input.releaseActiveSeats
    ? { ...rawObligations, liveSeats: 0 }
    : rawObligations;
  const total = Object.values(obligations).reduce((sum, n) => sum + n, 0);
  if (total > 0) {
    throw new MembershipGuardError(
      "MEMBER_HAS_OBLIGATIONS",
      "You still have upcoming sessions or money in progress under this organization. Settle or cancel those before leaving.",
      409,
      { ...obligations },
    );
  }
  return obligations;
}

/** Ends the member's invitations and team places on this organisation's plans. */
async function endOrgCollaborations(
  tx: Tx,
  orgId: string,
  userId: string,
  endedByUserId: string,
): Promise<EndedCollaboration[]> {
  const rows = await tx.collaborator.findMany({
    where: {
      status: { in: ["PENDING", "ACCEPTED"] },
      consultantProfile: { userId },
      OR: [
        { webinarPlan: { organizationId: orgId } },
        { classPlan: { organizationId: orgId } },
      ],
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const ended: EndedCollaboration[] = [];
  for (const { id } of rows) {
    // The member hears of the removal itself; only the host hears of each plan.
    const one = await endCollaboration(tx, {
      collaboratorId: id,
      to: "REMOVED",
      endedByUserId,
      notice: { event: "WITHDRAWN" },
    });
    if (one) ended.push(one);
  }
  return ended;
}

async function removeInTx(
  tx: Tx,
  input: RemoveMemberInput,
): Promise<PostCommit & RemoveMemberResult> {
  const { orgId, memberId, actor, actorUserId, force } = input;
  const current = await tx.membership.findFirst({
    where: { id: memberId, organizationId: orgId },
  });
  if (!current) {
    throw Object.assign(new Error("Member not found"), { httpStatus: 404 });
  }
  if (current.status === "REMOVED" || current.status === "ERASED") {
    return {
      removed: false,
      removedUserId: null,
      expertNotice: null,
      memberBells: [],
      email: null,
      endedCollaborations: [],
      endedSessions: [],
    };
  }

  const now = new Date();
  const isSelfLeave = "kind" in actor && actor.kind === "self";
  let obligations: RemovalObligations;
  let forced = false;

  if (isSelfLeave) {
    obligations = await validateSelfLeaveObligations(tx, current, input, now);
  } else {
    const res = await assertRemovable(tx, {
      membership: current,
      actor: {
        kind: "member",
        membershipId: actor.membershipId,
        role: actor.role,
      },
      force,
      now,
    });
    obligations = res.obligations;
    forced = res.forced;
  }

  await transitionMembership(tx, {
    where: { id: memberId, organizationId: orgId },
    to: "REMOVED",
  });
  const endedSessions = isSelfLeave
    ? []
    : (await revokeOrgManagedUserSessions(tx, orgId, current.userId)).ended;
  if (current.role === "EXPERT" && current.consultantProfileId) {
    await recomputeConsultantIsIndependent(tx, current.consultantProfileId);
  }

  const endedCollaborations = await endOrgCollaborations(
    tx,
    orgId,
    current.userId,
    actorUserId,
  );

  const terminated = await tx.programAssignment.updateMany({
    where: {
      membershipId: memberId,
      periodEnd: { gte: now },
      status: { in: ["ACTIVE", "PAUSED"] },
    },
    data: { periodEnd: now, status: "CANCELLED" },
  });
  await releaseSeatsForTerminatedAssignments(tx, [memberId], now);

  await tx.orgAuditLog.create({
    data: {
      organizationId: orgId,
      actorMembershipId: actor.membershipId,
      targetMembershipId: memberId,
      category: "MEMBER",
      action: AUDIT_ACTIONS.MEMBER.MEMBER_REMOVED,
      description: isSelfLeave
        ? "Member left the organization"
        : `Removed a ${MEMBER_ROLE_LABEL[current.role]} from the organization`,
      details: {
        role: current.role,
        previousStatus: current.status,
        assignmentsTerminated: terminated.count,
        ...(isSelfLeave && { selfLeave: true }),
        ...(forced && { forced: true, obligations: { ...obligations } }),
      },
    },
  });

  await dispatchWebhookEvent({
    prisma: tx,
    organizationId: orgId,
    eventType: "member.removed",
    payload: {
      membershipId: memberId,
      userId: current.userId,
      role: current.role,
      previousStatus: current.status,
    },
  });

  const org = await tx.organization.findUnique({
    where: { id: orgId },
    select: { name: true, slug: true },
  });
  const actorUser = await tx.user.findUnique({
    where: { id: actorUserId },
    select: { name: true, email: true },
  });
  if (!org) {
    return {
      removed: true,
      removedUserId: current.userId,
      expertNotice: null,
      memberBells: [],
      email: null,
      endedCollaborations,
      endedSessions,
    };
  }
  const actorName = actorUser?.name ?? actorUser?.email ?? "An operator";
  const dashboardUrl =
    current.role === "EXPERT"
      ? `${getAppUrl()}${goHref("expert")}`
      : "/dashboard";
  const email = await stageOrgMembershipChangedEmail(
    {
      userId: current.userId,
      membershipId: memberId,
      kind: "REMOVED",
      orgName: org.name,
      roleBefore: current.role,
      actorName,
      dashboardUrl,
    },
    tx,
  );

  if (current.role === "EXPERT") {
    return {
      removed: true,
      removedUserId: current.userId,
      email,
      memberBells: [],
      endedCollaborations,
      endedSessions,
      expertNotice: {
        userId: current.userId,
        payload: {
          orgName: org.name,
          orgSlug: org.slug,
          removedByName: actorName,
          reason: null,
          dashboardUrl,
        },
      },
    };
  }
  const memberBells =
    (await notifyOrgMemberRemoved(
      current.userId,
      {
        organizationId: orgId,
        orgName: org.name,
        removedByName: actorName,
        reason: null,
        dashboardUrl,
      },
      { tx },
    )) ?? [];
  return {
    removed: true,
    removedUserId: current.userId,
    expertNotice: null,
    memberBells,
    email,
    endedCollaborations,
    endedSessions,
  };
}

async function revokeRemovedMemberStream(
  orgId: string,
  removedUserId: string,
): Promise<void> {
  try {
    const revocation = await revokeMemberStreamAccess({
      userId: removedUserId,
      orgId,
    });
    if (!revocation.complete) {
      await enqueueOrgMemberRevocationRetry(orgId, removedUserId);
      Sentry.captureException(
        new Error(
          `Partial Stream revocation on org member removal: ${revocation.failures.join("; ")}`,
        ),
        {
          tags: { subsystem: "stream", op: "org.member-removal" },
          extra: { orgId, userId: removedUserId },
        },
      );
    }
  } catch (streamErr) {
    Sentry.captureException(
      streamErr instanceof Error ? streamErr : new Error(String(streamErr)),
      {
        tags: { subsystem: "stream", op: "org.member-removal" },
        extra: { orgId, userId: removedUserId },
      },
    );
  }
}

/**
 * Runs the removal Serializable (the last-OWNER count must not write-skew)
 * and fires the notices after commit. Throws `MembershipGuardError` or an
 * `httpStatus`-tagged error for the caller to map.
 */
export async function removeMember(
  input: RemoveMemberInput,
): Promise<RemoveMemberResult> {
  const result = await withSerializableRetry(() =>
    prisma.$transaction((tx) => removeInTx(tx, input), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    }),
  );

  await stampSessionEnds(result.endedSessions);
  // Fire-and-forget after commit: a failed notice must not undo a removal.
  if (result.expertNotice) {
    const notice = result.expertNotice;
    try {
      await notifyOrgExpertRemoved(notice.userId, notice.payload);
    } catch (notifyErr) {
      Sentry.captureException(
        notifyErr instanceof Error ? notifyErr : new Error(String(notifyErr)),
        { tags: { subsystem: "organizations" } },
      );
    }
  }
  if (result.email || result.memberBells.length > 0) {
    const staged = result.email;
    const bells = result.memberBells;
    await scheduleAfter(async () => {
      for (const row of bells) await attemptTrigger(row);
      if (staged) await attemptOnboardingEmail(staged);
    }, "org.member-removal.onboarding-email");
  }
  await afterCollaborationEnded(
    result.endedCollaborations,
    "org.member-removal.collaborator-withdrawn",
  );
  if (result.removedUserId) {
    await revokeRemovedMemberStream(input.orgId, result.removedUserId);
  }
  return { removed: result.removed };
}
