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
import { recomputeConsultantIsIndependent } from "@/lib/api/organizations/membership-transitions";
import { notifyOrgExpertRemoved } from "@/lib/novu/service";
import type { OrgExpertRemovedPayload } from "@/lib/novu/workflows";
import { goHref } from "@/lib/dashboard/go";
import {
  attemptOnboardingEmail,
  stageOrgMembershipChangedEmail,
  type StagedOnboardingEmail,
} from "@/lib/email";
import { scheduleAfter } from "@/lib/api/after-safe";
import {
  CLASS_PREFIX,
  WEBINAR_PREFIX,
  getChannelTypeFromId,
} from "@/lib/stream-channel-ids";
import { bookingOrgId, getDmChannelId } from "@/lib/stream-utils";
import { dmEligibleStatusFilter } from "@/lib/stream/dm-eligibility-statuses";
import {
  chunk,
  pause,
  STREAM_BATCH_PAUSE_MS,
  STREAM_CONCURRENCY_LIMIT,
} from "@/lib/stream/batch";

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
 *
 * ## Stream access ends here too (org security boundary)
 *
 * This file used to import nothing from Stream at all. That left a removed
 * member able to mint one-hour chat and video tokens FOREVER:
 * `assertCanMintToken` checks session identity and the platform-level
 * `session.user.banned` flag, never org membership, so nothing on the token
 * or join path ever re-derived "are they still in this org". They kept reading
 * and writing every `webinar-*` / `class-*` channel and every `dmo-<org>-…`
 * thread until some unrelated booking cancellation happened to trip the
 * booking-derived reconciler.
 *
 * The revocation runs AFTER the transaction commits and is never inside it —
 * the rule is that a provider call must not hold a Prisma transaction open, and
 * a rollback must not be able to un-revoke. See `revokeMemberStreamAccess`.
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
  /** Non-null only for a removal that actually moved the row. */
  streamRevocation: { userId: string; orgId: string } | null;
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
    return {
      removed: false,
      expertNotice: null,
      email: null,
      // The first attempt already ran (or already failed and is the sweep's
      // problem); re-running it here would only spend a second Stream call.
      streamRevocation: null,
    };
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
  if (!org) {
    return {
      removed: true,
      expertNotice: null,
      email: null,
      streamRevocation: { userId: current.userId, orgId },
    };
  }
  const actorName = actorUser?.name ?? actorUser?.email ?? "An operator";

  // An EXPERT hears through Novu; everyone else gets the membership email,
  // staged here so it commits with the removal (review round 2 on #1700).
  if (current.role === "EXPERT") {
    return {
      removed: true,
      email: null,
      streamRevocation: { userId: current.userId, orgId },
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
  return {
    removed: true,
    expertNotice: null,
    email,
    streamRevocation: { userId: current.userId, orgId },
  };
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
    scheduleAfter(
      () => attemptOnboardingEmail(staged),
      "org.member-removal.onboarding-email",
    );
  }
  // The org security boundary. AFTER the commit, never inside it: a provider
  // call inside a Serializable transaction holds a Postgres connection and a
  // Serializable snapshot open across a network round trip (this removal runs
  // with `withSerializableRetry`, so a slow Stream would also burn retry
  // attempts on write-skew it never caused). And the direction of the coupling
  // matters: a rollback must not be able to un-revoke, and a vendor failure must
  // not be able to roll back a removal that has already been decided.
  if (result.streamRevocation) {
    const target = result.streamRevocation;
    try {
      // Returns rather than throws, so the summary is inspectable: a revoke
      // that reported success while landing nothing is exactly the failure mode
      // this whole change exists to close.
      const outcome = await revokeMemberStreamAccess(target);
      if (outcome.error) {
        Sentry.captureException(new Error(outcome.error), {
          tags: { subsystem: "stream", op: "org.member-removal.revoke" },
          extra: {
            orgId: target.orgId,
            userId: target.userId,
            tokenRevoked: outcome.tokenRevoked,
            channelsConsidered: outcome.channelsConsidered,
            channelsEvicted: outcome.channelsEvicted,
          },
        });
      }
    } catch (revokeErr) {
      Sentry.captureException(
        revokeErr instanceof Error ? revokeErr : new Error(String(revokeErr)),
        {
          tags: { subsystem: "stream", op: "org.member-removal.revoke" },
          extra: { orgId: target.orgId, userId: target.userId },
        },
      );
    }
  }
  return { removed: result.removed };
}

/* -------------------------------------------------------------------------- */
/* Stream revocation — the org membership boundary on the Stream path          */
/* -------------------------------------------------------------------------- */

/**
 * How long a removed membership keeps owing a Stream revocation.
 *
 * 72h, the same horizon `retry-moderation-enforcement` gives up past: a ban
 * whose Stream revocation never landed in three days needs an operator, not a
 * seventh attempt.
 */
export const STREAM_REVOCATION_RETRY_WINDOW_HOURS = 72;

/**
 * Row cap on the surface scans.
 *
 * A pathological org (thousands of historic bookings) must not be able to hold
 * the cron open; the caller reports a truncated page rather than deciding
 * destructively from an incomplete one — the rule `runDmStage` already follows.
 */
const SURFACE_SCAN_LIMIT = 2_000;

/** The Stream channels an org owns, split by shape. */
export interface OrgStreamSurfaces {
  /** `webinar-*` / `class-*` — the shared team channels. */
  eventChannelIds: string[];
  /** `dmo-*` — one thread per (pair, org) for every DM-eligible booking. */
  dmChannelIds: string[];
}

/**
 * Which Stream channels this org owns, optionally narrowed to the ones one
 * person is in.
 *
 * The org tag is resolved through `bookingOrgId`, never through
 * `Appointment.organizationId` alone: a plan can be org-HOSTED while the
 * booking is self-funded, and vice versa, and reading only one of the two is
 * how the reconciler's expected set came to disagree with the channels that
 * actually existed (#1134 P0-8). `bookingOrgId` is that precedence in one
 * place, so the server-side `where` below only has to be a SUPERSET — every
 * candidate is re-resolved locally before it is returned.
 *
 * DMs are filtered by `DM_ELIGIBLE_STATUSES` for the same reason the reconciler
 * filters by it: a booking nobody reached never had a channel, so evicting
 * "one" would be a no-op on a channel that does not exist.
 */
export async function loadOrgStreamSurfaces(
  orgId: string,
  opts: { userId?: string } = {},
): Promise<OrgStreamSurfaces> {
  const { userId } = opts;

  const [appointments, consultations, subscriptions] = await Promise.all([
    prisma.appointment.findMany({
      where: {
        OR: [
          { organizationId: orgId },
          { webinar: { webinarPlan: { organizationId: orgId } } },
          { class: { classPlan: { organizationId: orgId } } },
        ],
      },
      take: SURFACE_SCAN_LIMIT,
      orderBy: { createdAt: "desc" },
      select: {
        organizationId: true,
        webinar: {
          select: {
            id: true,
            webinarPlan: { select: { organizationId: true } },
          },
        },
        class: {
          select: { id: true, classPlan: { select: { organizationId: true } } },
        },
      },
    }),
    prisma.consultation.findMany({
      where: {
        status: dmEligibleStatusFilter(),
        AND: [
          {
            OR: [
              { appointment: { organizationId: orgId } },
              { consultationPlan: { organizationId: orgId } },
            ],
          },
          ...(userId
            ? [
                {
                  OR: [
                    { requestedBy: { userId } },
                    { consultationPlan: { consultantProfile: { userId } } },
                  ],
                },
              ]
            : []),
        ],
      },
      take: SURFACE_SCAN_LIMIT,
      orderBy: { requestedAt: "desc" },
      select: {
        consultationPlan: {
          select: {
            organizationId: true,
            consultantProfile: { select: { user: { select: { id: true } } } },
          },
        },
        requestedBy: { select: { user: { select: { id: true } } } },
        appointment: { select: { organizationId: true } },
      },
    }),
    prisma.subscription.findMany({
      where: {
        status: dmEligibleStatusFilter(),
        AND: [
          {
            OR: [
              { appointment: { organizationId: orgId } },
              { subscriptionPlan: { organizationId: orgId } },
            ],
          },
          ...(userId
            ? [
                {
                  OR: [
                    { requestedBy: { userId } },
                    { subscriptionPlan: { consultantProfile: { userId } } },
                  ],
                },
              ]
            : []),
        ],
      },
      take: SURFACE_SCAN_LIMIT,
      orderBy: { requestedAt: "desc" },
      select: {
        subscriptionPlan: {
          select: {
            organizationId: true,
            consultantProfile: { select: { user: { select: { id: true } } } },
          },
        },
        requestedBy: { select: { user: { select: { id: true } } } },
        appointment: { select: { organizationId: true } },
      },
    }),
  ]);

  const eventChannelIds = new Set<string>();
  for (const appointment of appointments) {
    // Plan-before-appointment, again — locally, because the `where` above is a
    // superset.
    if (
      bookingOrgId({
        webinarPlan: appointment.webinar?.webinarPlan,
        classPlan: appointment.class?.classPlan,
        appointment: { organizationId: appointment.organizationId },
      }) !== orgId
    ) {
      continue;
    }
    if (appointment.webinar) {
      eventChannelIds.add(`${WEBINAR_PREFIX}${appointment.webinar.id}`);
    }
    if (appointment.class) {
      eventChannelIds.add(`${CLASS_PREFIX}${appointment.class.id}`);
    }
  }

  const dmChannelIds = new Set<string>();
  const addDm = (
    bookingOrg: string | null,
    consultantUserId: string | undefined,
    consulteeUserId: string | undefined,
  ) => {
    if (bookingOrg !== orgId) return;
    if (!consultantUserId || !consulteeUserId) return;
    // Belt-and-braces: the server-side `where` already narrowed by user, but
    // `bookingOrgId`'s precedence is the authority and it is re-derived here.
    if (userId && consultantUserId !== userId && consulteeUserId !== userId) {
      return;
    }
    try {
      dmChannelIds.add(
        getDmChannelId(consultantUserId, consulteeUserId, orgId),
      );
    } catch {
      // `getDmChannelId` throws on a self-pair. Seed data has produced those;
      // there is no channel to revoke for one.
    }
  };
  for (const c of consultations) {
    addDm(
      bookingOrgId({
        consultationPlan: c.consultationPlan,
        appointment: c.appointment,
      }),
      c.consultationPlan?.consultantProfile?.user?.id,
      c.requestedBy?.user?.id,
    );
  }
  for (const s of subscriptions) {
    addDm(
      bookingOrgId({
        subscriptionPlan: s.subscriptionPlan,
        appointment: s.appointment,
      }),
      s.subscriptionPlan?.consultantProfile?.user?.id,
      s.requestedBy?.user?.id,
    );
  }

  return {
    eventChannelIds: Array.from(eventChannelIds),
    dmChannelIds: Array.from(dmChannelIds),
  };
}

/** Outcome of one member's Stream revocation. Never throws. */
export interface MemberStreamRevocationResult {
  userId: string;
  orgId: string;
  /**
   * Why nothing was sent. `reinstated` is the still-applicable guard: a person
   * who came back to the org inside the retry window must not be evicted by the
   * sweep that is re-driving an OLD removal. `stream_unconfigured` means the
   * deployment has lost its credentials — reported as an error, never as a
   * clean skip, for the reason `expire-event-channels` gives.
   */
  skipped: "reinstated" | "stream_unconfigured" | null;
  tokenRevoked: boolean;
  channelsConsidered: number;
  channelsEvicted: number;
  channelFailures: string[];
  error: string | null;
}

/**
 * Revoke one person's Stream access to one org: kill their tokens, then evict
 * them from every channel that org owns.
 *
 * ## Why `revokeUserToken` and not only a channel removal
 *
 * `revokeUserToken(userId, now)` sets `revoke_tokens_issued_before = now`, which
 * kills every socket the user holds AND every token already in the wild — the
 * removed member could be holding a one-hour chat token minted a minute before
 * the removal, and channel membership alone would leave it working until it
 * expired. Removing them from channels does NOT invalidate a token they already
 * hold; this does. It is the same primitive `lib/moderation/side-effects.ts`
 * uses for a ban.
 *
 * It is app-wide, which is correct here rather than merely acceptable. Tokens
 * carry `iat` (the rule in the stream skill), so a token minted AFTER this
 * instant is accepted again — a person who is still an active member of some
 * other org simply reconnects with a fresh token and keeps the access they are
 * entitled to. It kills connections, it does not lock anyone out.
 *
 * ## Ordering, and what a failure means
 *
 * The token revoke and the eviction are separate breaker scopes on purpose: a
 * 404 because the person has never connected to Stream must not stop us
 * evicting them from the channels they are demonstrably in.
 *
 * Nothing here throws. The local removal has already committed by the time this
 * runs and must not be undone by a vendor outage; the sweep re-drives anything
 * still owed.
 */
export async function revokeMemberStreamAccess(args: {
  userId: string;
  orgId: string;
}): Promise<MemberStreamRevocationResult> {
  const { userId, orgId } = args;
  const base: MemberStreamRevocationResult = {
    userId,
    orgId,
    skipped: null,
    tokenRevoked: false,
    channelsConsidered: 0,
    channelsEvicted: 0,
    channelFailures: [],
    error: null,
  };

  // Lazy: a static import would pull the Stream client graph into every
  // request that can remove a member. Same reasoning as
  // `lib/moderation/side-effects.ts`'s lazy import of the collaborators service.
  const {
    getStreamChatClient,
    isStreamConfigured,
    isExpectedStreamError,
    withStreamCircuitBreaker,
  } = await import("@/lib/stream-client");

  if (!isStreamConfigured()) {
    return {
      ...base,
      skipped: "stream_unconfigured",
      error: "Stream is not configured — revocation not attempted",
    };
  }

  // Still applicable? The sweep re-drives removals for up to
  // STREAM_REVOCATION_RETRY_WINDOW_HOURS, and a reactivation inside that window
  // must not be undone by it — the same reason `stillApplicable` exists in
  // retry-moderation-enforcement (never re-enforce a ban that was lifted).
  const reinstated = await prisma.membership.findFirst({
    where: {
      userId,
      organizationId: orgId,
      status: { in: ["ACTIVE", "PENDING"] },
    },
    select: { id: true },
  });
  if (reinstated) return { ...base, skipped: "reinstated" };

  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  try {
    await withStreamCircuitBreaker(() =>
      getStreamChatClient().revokeUserToken(userId, new Date()),
    );
    base.tokenRevoked = true;
  } catch (error) {
    base.error = errMsg(error);
    base.channelFailures.push(`revokeUserToken: ${base.error}`);
  }

  const surfaces = await loadOrgStreamSurfaces(orgId, { userId });
  const channelIds = [...surfaces.eventChannelIds, ...surfaces.dmChannelIds];
  base.channelsConsidered = channelIds.length;

  for (const [batchIdx, batch] of chunk(
    channelIds,
    STREAM_CONCURRENCY_LIMIT,
  ).entries()) {
    if (batchIdx > 0) await pause(STREAM_BATCH_PAUSE_MS);
    const outcomes = await Promise.allSettled(
      batch.map((channelId) =>
        withStreamCircuitBreaker(() =>
          getStreamChatClient()
            .channel(getChannelTypeFromId(channelId), channelId)
            .removeMembers([userId]),
        ),
      ),
    );
    outcomes.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") {
        base.channelsEvicted++;
        return;
      }
      // A person who was never in the channel is the expected answer — channels
      // are minted lazily and `removeMembers` on a non-member 404s. Treating
      // that as a failure would page Sentry on every removal, which is exactly
      // what `removeUserFromEventChannel` stopped doing.
      if (isExpectedStreamError(outcome.reason)) {
        base.channelsEvicted++;
        return;
      }
      base.channelFailures.push(`${batch[i]}: ${errMsg(outcome.reason)}`);
    });
  }

  if (base.channelFailures.length > 0 && base.error === null) {
    base.error = base.channelFailures.join("; ");
  }
  return base;
}
