import * as Sentry from "@sentry/nextjs";
import { Prisma } from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";
import { transitionMembership } from "@/lib/enterprise/transitions";
import {
  assertRemovable,
  type GuardedMembership,
} from "@/lib/enterprise/membership-guards";
import { releaseSeatsForTerminatedAssignments } from "@/lib/api/organizations/seat-count";
import {
  bumpUserSessionGeneration,
  recomputeConsultantIsIndependent,
} from "@/lib/api/organizations/membership-transitions";
import { notifyOrgExpertRemoved } from "@/lib/novu/service";
import type { OrgExpertRemovedPayload } from "@/lib/novu/workflows";
import { goHref } from "@/lib/dashboard/go";
import {
  attemptOnboardingEmail,
  stageOrgMembershipChangedEmail,
  type StagedOnboardingEmail,
} from "@/lib/email";
import { scheduleAfter } from "@/lib/api/after-safe";

/**
 * ORG-07 — the one removal path. DELETE and PATCH `status: REMOVED` used to
 * run two copies with different guards (PATCH skipped the in-flight-money
 * check, the webhook and the Novu notice). Both now call `removeMember`, so
 * the obligations check, the last-OWNER rule and the cascade are shared.
 *
 * Soft delete (status REMOVED), never a hard delete: audit rows, payouts,
 * earnings and wallet entries reference the Membership. REMOVED is not
 * terminal for the person, only for this route: coming back means a new
 * invitation, which the accept route turns into a reactivation (#1846 C3).
 */

export interface RemoveMemberInput {
  orgId: string;
  memberId: string;
  actor: { membershipId: string; role: GuardedMembership["role"] };
  actorUserId: string;
  force: boolean;
}

export type RemoveMemberResult = { removed: boolean };

interface PostCommit {
  expertNotice: { userId: string; payload: OrgExpertRemovedPayload } | null;
  email: StagedOnboardingEmail | null;
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
  // Idempotent: a repeat removal is a no-op that still succeeds.
  if (current.status === "REMOVED" || current.status === "ERASED") {
    return { removed: false, expertNotice: null, email: null };
  }

  const now = new Date();
  const { obligations, forced } = await assertRemovable(tx, {
    membership: current,
    actor: { kind: "member", ...actor },
    force,
    now,
  });

  // The CAS makes a concurrent double removal 409 instead of re-running the
  // cascade.
  await transitionMembership(tx, {
    where: { id: memberId, organizationId: orgId },
    to: "REMOVED",
  });
  // Without the bump a removed member keeps acting on org routes until the
  // cached session rotates (Phase B.5).
  await bumpUserSessionGeneration(tx, current.userId);
  if (current.role === "EXPERT" && current.consultantProfileId) {
    await recomputeConsultantIsIndependent(tx, current.consultantProfileId);
  }

  // Past OrganizationEarnings stay untouched: delivered sessions are settled
  // commitments, and no new org split accrues once the EXPERT row is gone.
  //
  // Live seats close at `now` (only an OWNER force reaches here with some):
  // a removed member's seat must stop counting against the program cap and
  // the billed seat count. ROLLED/CLOSED rows are never re-stamped.
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
      description: `Removed member ${memberId}`,
      details: {
        role: current.role,
        previousStatus: current.status,
        assignmentsTerminated: terminated.count,
        // #779 §C — an OWNER override records what was knowingly left open.
        ...(forced && { forced: true, obligations: { ...obligations } }),
      },
    },
  });

  // In the tx so a rollback also drops the delivery row.
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

  const [org, actorUser] = await Promise.all([
    tx.organization.findUnique({
      where: { id: orgId },
      select: { name: true, slug: true },
    }),
    tx.user.findUnique({
      where: { id: actorUserId },
      select: { name: true, email: true },
    }),
  ]);
  if (!org) return { removed: true, expertNotice: null, email: null };
  const actorName = actorUser?.name ?? actorUser?.email ?? "An operator";

  // An EXPERT hears through Novu; everyone else gets the membership email,
  // staged here so it commits with the removal (review round 2 on #1700).
  if (current.role === "EXPERT") {
    return {
      removed: true,
      email: null,
      expertNotice: {
        userId: current.userId,
        payload: {
          orgName: org.name,
          orgSlug: org.slug,
          removedByName: actorName,
          reason: null,
          dashboardUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}${goHref("expert")}`,
        },
      },
    };
  }
  const email = await stageOrgMembershipChangedEmail(
    {
      userId: current.userId,
      membershipId: memberId,
      kind: "REMOVED",
      orgName: org.name,
      roleBefore: current.role,
      actorName,
      dashboardUrl: "/dashboard",
    },
    tx,
  );
  return { removed: true, expertNotice: null, email };
}

/**
 * Runs the removal Serializable (N4: the last-OWNER count must not write-skew)
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
  if (result.email) {
    const staged = result.email;
    scheduleAfter(() => attemptOnboardingEmail(staged));
  }
  return { removed: result.removed };
}
