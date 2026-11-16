import type { Collaborator, CollaboratorStatus, Prisma } from "@prisma/client";
import type { CollaborationLifecycleEvent } from "@/emails/collaborations/CollaborationLifecycleEmail";
import {
  flushNotificationsAfter,
  type StagedNotificationBundle,
} from "@/lib/novu/stage-then-attempt";
import { reportSentryError } from "@/lib/observability/report";
import type { Tx } from "@/lib/prisma";
import { stageCollaboratorNotifications } from "./notifications";
import type { PlanRef } from "./team";

// Loaded on first use: ban, erasure and member removal import this module and
// must not load the Stream and auth graph until a collaboration really ends.
const accessRevocation = () => import("@/lib/stream/access-revocation");

/** The four ways a collaboration ends. */
export type CollaborationEnding =
  "DECLINED" | "EXPIRED" | "REMOVED" | "WITHDRAWN";

/** Declining and expiry end an invitation, leaving ends a place on the team, removal ends either. */
const ENDS_FROM: Record<CollaborationEnding, CollaboratorStatus[]> = {
  DECLINED: ["PENDING"],
  EXPIRED: ["PENDING"],
  WITHDRAWN: ["ACCEPTED"],
  REMOVED: ["PENDING", "ACCEPTED"],
};

export type EndCollaborationArgs = {
  collaboratorId: string;
  to: CollaborationEnding;
  /** The person who ended it; null when the platform did. */
  endedByUserId: string | null;
  /** Further conditions the row must meet for the change to apply. */
  where?: Prisma.CollaboratorWhereInput;
  /** The notice to stage instead of the one named after `to`; `anonymous` withholds the collaborator's name. */
  notice?: { event?: CollaborationLifecycleEvent; anonymous?: boolean };
  /** True when the caller records the access to take back in a queue of its own that never gives up. */
  ownRevocationQueue?: boolean;
};

/** What the caller hands to `afterCollaborationEnded` once its transaction commits. */
export type EndedCollaboration = {
  collaborator: Collaborator;
  ref: PlanRef;
  userId: string;
  wasOnTeam: boolean;
  /** The revocation the transaction wrote; null when the row never held access. */
  revocationGeneration: Date | null;
  notices: StagedNotificationBundle;
};

function refOf(row: Collaborator): PlanRef | null {
  if (row.webinarPlanId) {
    return { planType: "webinar", planId: row.webinarPlanId };
  }
  if (row.classPlanId) return { planType: "class", planId: row.classPlanId };
  return null;
}

/**
 * Ends one collaboration inside the caller's transaction: the status change,
 * its notices and, for someone who was on the team, the order to take their
 * access back all commit together. Returns null when the row was not in a
 * status this ending applies to.
 */
export async function endCollaboration(
  tx: Tx,
  args: EndCollaborationArgs,
): Promise<EndedCollaboration | null> {
  const [collaborator] = await tx.collaborator.updateManyAndReturn({
    where: {
      ...args.where,
      id: args.collaboratorId,
      status: { in: ENDS_FROM[args.to] },
    },
    data: { status: args.to, endedByUserId: args.endedByUserId },
  });
  if (!collaborator) return null;
  const ref = refOf(collaborator);
  const profile = await tx.consultantProfile.findUnique({
    where: { id: collaborator.consultantProfileId },
    select: { userId: true },
  });
  if (!ref || !profile) return null;

  const wasOnTeam = collaborator.acceptedAt !== null;
  const revocationGeneration =
    wasOnTeam && !args.ownRevocationQueue
      ? await (
          await accessRevocation()
        ).persistCollaboratorRevocationInTx(tx, ref, profile.userId)
      : null;
  const notices = await stageCollaboratorNotifications(
    tx,
    args.notice?.event ?? args.to,
    collaborator,
    args.notice?.anonymous ? { collaboratorName: "A collaborator" } : {},
  );
  return {
    collaborator,
    ref,
    userId: profile.userId,
    wasOnTeam,
    revocationGeneration,
    notices,
  };
}

/**
 * Ends every invitation and team place a user holds, as REMOVED, when their
 * account loses the standing a collaborator needs. Each host hears that a
 * collaborator left, unnamed, because the account may be leaving the platform.
 */
export async function endCollaborationsForUser(
  tx: Tx,
  userId: string,
  opts: { endedByUserId: string | null; ownRevocationQueue?: boolean },
): Promise<EndedCollaboration[]> {
  const rows = await tx.collaborator.findMany({
    where: {
      consultantProfile: { userId },
      status: { in: ["PENDING", "ACCEPTED"] },
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const ended: EndedCollaboration[] = [];
  for (const { id } of rows) {
    const one = await endCollaboration(tx, {
      collaboratorId: id,
      to: "REMOVED",
      endedByUserId: opts.endedByUserId,
      notice: { event: "WITHDRAWN", anonymous: true },
      ownRevocationQueue: opts.ownRevocationQueue,
    });
    if (one) ended.push(one);
  }
  return ended;
}

/**
 * Runs once the ending transaction has committed: attempts the notices now
 * and takes back the access of anyone who was on the team. Never throws; what
 * it leaves undone is already recorded and the sweeps finish it.
 */
export async function afterCollaborationEnded(
  ended: EndedCollaboration | readonly EndedCollaboration[],
  op: string,
): Promise<void> {
  const list = Array.isArray(ended) ? ended : [ended];
  if (list.length === 0) return;
  try {
    await flushNotificationsAfter(
      {
        bells: list.flatMap((e) => e.notices.bells ?? []),
        emails: list.flatMap((e) => e.notices.emails ?? []),
      },
      op,
    );
    const owed = list.filter((e) => e.revocationGeneration);
    if (owed.length === 0) return;
    const { revokeCollaboratorAccess } = await accessRevocation();
    for (const e of owed) {
      await revokeCollaboratorAccess(e.ref, e.userId, e.revocationGeneration);
    }
  } catch (error) {
    reportSentryError(error, {
      subsystem: "collaborators",
      op: `${op}.afterEnded`,
      extra: { collaboratorIds: list.map((e) => e.collaborator.id) },
    });
  }
}
