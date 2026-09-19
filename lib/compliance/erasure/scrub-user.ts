/**
 * DPDP §12 right-to-erasure scrub pipeline.
 *
 * What gets erased
 * ----------------
 *   User.name        → "Erased User <8-char-hash>"
 *   User.email       → "erased-<hash>@erased.invalid"
 *   User.image, phone, address, bio, linkedinUrl, dateOfBirth → NULL
 *   User.erasedAt    → now()
 *   User.pseudonymousId → sha256(userId + ERASURE_SALT)
 *
 *   Membership[].status   → ERASED (every active row across every org)
 *   Collaborator.status   → REMOVED (every PENDING/ACCEPTED row, #1580)
 *   ConsultantProfile.headline / videoIntroUrl → NULL, deletedAt → now()
 *   ConsulteeProfile.goals → NULL (#1598 P4-P0-05)
 *   Trial.notes and Consultation.requestNotes the consultee wrote → NULL
 *
 *   BetterAuth Session + Account rows → hard-deleted (forces sign-out
 *   across every device immediately; SSO accounts are dropped too).
 *
 * What survives intact (per Indian IT Act §44AA / §92 retention rules
 * and per the financial-records carve-out in DPDP §12):
 *
 *   Payment*, OrganizationInvoice, OrganizationPayout,
 *   WalletEntry, FundingLedgerEntry, SettlementLedgerEntry, Refund.
 *
 * Why pseudonymousId rather than NULL on every PII field
 * ------------------------------------------------------
 * Investigations after erasure (financial fraud, regulatory queries)
 * still need a way to correlate audit-log rows that reference the user
 * without exposing the original identifiers. The pseudonymous id is a
 * one-way deterministic hash — same id every time, never reversible.
 *
 * Idempotency
 * -----------
 * If `User.erasedAt IS NOT NULL`, the function returns the existing
 * `pseudonymousId` without writing. Safe to call multiple times.
 *
 * Webhook fan-out
 * ---------------
 * Emits `member.removed` per affected organization so SCIM-managed and
 * webhook-subscribed downstreams see the deprovisioning. The
 * dispatching is fire-and-forget inside the same transaction so a
 * rollback (e.g. constraint violation we didn't anticipate) takes the
 * webhook rows with it.
 */

import { createHash } from "node:crypto";
import type { Db } from "@/lib/prisma";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";
import { releaseSeatsForTerminatedAssignments } from "@/lib/api/organizations/seat-count";
import {
  removeCollaboratorStanding,
  type CollaborationRef,
} from "@/lib/collaborators/standing";
import { reportSentryError } from "@/lib/observability/report";
import { nextRetryAt } from "@/lib/retry/backoff";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";

export interface ScrubResult {
  /// True iff this call performed the scrub. False means the user was
  /// already erased on a prior call (idempotency path).
  scrubbed: boolean;
  pseudonymousId: string;
  affectedOrganizationIds: string[];
}

/**
 * Deterministic pseudonym derivation. The salt is read at call time
 * so the `ERASURE_SALT` env can be rotated without code change in an
 * emergency — old erasures are NOT re-keyed (their pseudonymousId is
 * locked in at scrub time and stored on the User row).
 */
function derivePseudonym(userId: string): string {
  const salt = process.env.ERASURE_SALT;
  // #1584 P1-ER01 — in production a pseudonym keyed on the public fallback is
  // reversible by anyone with the source; refuse rather than scrub with it.
  if (!salt && process.env.NODE_ENV === "production") {
    throw Object.assign(new Error("ERASURE_SALT is not configured"), {
      httpStatus: 500,
      code: "ERASURE_SALT_MISSING",
    });
  }
  return createHash("sha256")
    .update(`${userId}.${salt ?? "familiarise-erasure-fallback"}`)
    .digest("hex");
}

export interface MoneyInFlight {
  /** ConsultantPayout rows in PENDING/APPROVED/PROCESSING for the user's profile. */
  consultantPayouts: number;
  /** ConsultantEarnings in READY/BATCHED — money owed but not yet paid out. */
  unsettledEarnings: number;
  /** ISSUED/OVERDUE OrganizationInvoice rows on orgs where the user is the only OWNER. */
  orgInvoicesAsSoleOwner: number;
  /** Disputes still contested on the user's payments. */
  liveDisputes: number;
}

/**
 * #1598 P4-P0-05 — money that cannot be settled once the identity behind it
 * is gone. The predicate shape mirrors the org wind-down gate
 * (app/api/organizations/[orgId]/route.ts); the process route refuses with
 * ERASURE_BLOCKED_MONEY_IN_FLIGHT while any count is non-zero.
 */
export async function moneyInFlightForUser(
  db: Db,
  userId: string,
): Promise<MoneyInFlight> {
  const [consultantPayouts, unsettledEarnings, liveDisputes, ownerRows] =
    await Promise.all([
      db.consultantPayout.count({
        where: {
          consultantProfile: { userId },
          status: { in: ["PENDING", "APPROVED", "PROCESSING"] },
        },
      }),
      db.consultantEarnings.count({
        where: {
          consultantProfile: { userId },
          status: { in: ["READY", "BATCHED"] },
        },
      }),
      db.dispute.count({
        where: {
          payment: { userId },
          status: { notIn: DISPUTE_INACTIVE_FOR_GATING },
        },
      }),
      db.membership.findMany({
        where: { userId, role: "OWNER", status: "ACTIVE" },
        select: { organizationId: true },
      }),
    ]);

  let orgInvoicesAsSoleOwner = 0;
  for (const { organizationId } of ownerRows) {
    const otherOwners = await db.membership.count({
      where: {
        organizationId,
        role: "OWNER",
        status: "ACTIVE",
        userId: { not: userId },
      },
    });
    if (otherOwners > 0) continue;
    orgInvoicesAsSoleOwner += await db.organizationInvoice.count({
      where: { organizationId, status: { in: ["ISSUED", "OVERDUE"] } },
    });
  }

  return {
    consultantPayouts,
    unsettledEarnings,
    orgInvoicesAsSoleOwner,
    liveDisputes,
  };
}

/** True when any money-in-flight count is non-zero. */
export function hasMoneyInFlight(counts: MoneyInFlight): boolean {
  return Object.values(counts).some((n) => n > 0);
}

// #780 — extended client, not bare PrismaClient, so the itx client passed to
// dispatchWebhookEvent satisfies PrismaLike.
export async function scrubUser(
  prisma: Db,
  userId: string,
): Promise<ScrubResult> {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      erasedAt: true,
      pseudonymousId: true,
    },
  });
  if (!existing) {
    throw Object.assign(new Error("User not found"), { httpStatus: 404 });
  }
  if (existing.erasedAt && existing.pseudonymousId) {
    // Idempotency: nothing to do. Return the existing pseudonym so
    // callers can still react (e.g. audit "we processed the request"
    // for compliance trail).
    return {
      scrubbed: false,
      pseudonymousId: existing.pseudonymousId,
      affectedOrganizationIds: [],
    };
  }

  const pseudonymousId = derivePseudonym(userId);
  const shortHash = pseudonymousId.slice(0, 8);
  const scrubbedEmail = `erased-${pseudonymousId.slice(0, 16)}@erased.invalid`;
  const now = new Date();

  // Collect affected memberships BEFORE the transaction so we know
  // which orgs to fan webhooks out to.
  const memberships = await prisma.membership.findMany({
    where: {
      userId,
      // Avoid re-suspending memberships that are already terminal.
      status: { in: ["PENDING", "ACTIVE", "SUSPENDED"] },
    },
    select: { id: true, organizationId: true, role: true, status: true },
  });
  const affectedOrganizationIds = Array.from(
    new Set(memberships.map((m) => m.organizationId)),
  );

  let collaborationsRemoved: CollaborationRef[] = [];
  let erasureRequestId: string | null = null;
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        name: `Erased User ${shortHash}`,
        email: scrubbedEmail,
        image: null,
        phone: null,
        address: null,
        bio: null,
        linkedinUrl: null,
        dateOfBirth: null,
        // city + country stay populated for geographic compliance
        // reporting (the regulator may need "how many users in IN
        // exercised erasure last quarter") — they don't identify the
        // individual.
        erasedAt: now,
        pseudonymousId,
      },
    });

    if (memberships.length > 0) {
      await tx.membership.updateMany({
        where: { userId, status: { in: ["PENDING", "ACTIVE", "SUSPENDED"] } },
        data: { status: "ERASED" },
      });
      // ERASED is terminal — without this, an erased member's live
      // allocations keep counting against program caps and entitlements,
      // same as the member-removal cascade (members route). Status-guarded
      // so ROLLED/CLOSED history is never re-stamped.
      await tx.programAssignment.updateMany({
        where: {
          membershipId: { in: memberships.map((m) => m.id) },
          periodEnd: { gte: now },
          status: { in: ["ACTIVE", "PAUSED"] },
        },
        data: { periodEnd: now, status: "CANCELLED" },
      });
      // E2E-audit P1 fix — erasure must also release billed seats, same as
      // member removal (the reconcile invariant reads activeSeatCount).
      await releaseSeatsForTerminatedAssignments(
        tx,
        memberships.map((m) => m.id),
      );
    }

    // Free-text PII on profiles (best-effort — fields may or may not
    // be set per role). The narrow `update` returns 0 rows when the
    // user has no consultant/consultee profile, which is fine.
    await tx.consultantProfile.updateMany({
      where: { user: { id: userId } },
      data: {
        headline: null,
        videoIntroUrl: null,
        // #781 §B — erasure implies the profile leaves every browse/checkout
        // surface; financial rows stay (statutory retention beats erasure
        // under DPDP's legal-obligation exemption).
        deletedAt: new Date(),
      },
    });
    // #1598 P4-P0-05 — the consultee's own free text: profile goals, trial
    // notes and consultation request notes are what they wrote about themselves.
    await tx.consulteeProfile.updateMany({
      where: { userId },
      data: { goals: null },
    });
    await tx.trial.updateMany({
      where: { consulteeProfile: { userId } },
      data: { notes: null },
    });
    await tx.consultation.updateMany({
      where: { requestedBy: { userId } },
      data: { requestNotes: null },
    });

    // #1580 — an erased consultant otherwise stays an ACCEPTED collaborator in
    // every split and roster; the same flip the moderation ban runs.
    collaborationsRemoved = await removeCollaboratorStanding(tx, userId);

    // #1593 — the OUTBOX: every Stream revocation this scrub owes is a durable
    // row before the side effect is attempted, in the same transaction as the
    // rows it follows from, so a crash between commit and Stream leaves a
    // sweep-visible debt rather than a silent one. The post-commit attempt
    // below completes the row; the retry sweep drains whatever it could not.
    const request = await tx.erasureRequest.findFirst({
      where: { userId, status: { in: ["PENDING", "IN_PROGRESS"] } },
      orderBy: { requestedAt: "desc" },
      select: { id: true },
    });
    erasureRequestId = request?.id ?? null;
    if (erasureRequestId && collaborationsRemoved.length > 0) {
      await tx.streamRevocationRetry.createMany({
        data: collaborationsRemoved.map(({ planType, planId }) => ({
          erasureRequestId: erasureRequestId as string,
          planType: planType === "webinar" ? "WEBINAR" : "CLASS",
          planId,
        })),
        skipDuplicates: true,
      });
    }

    // Hard-delete sessions + accounts so SSO and password-based logins
    // both break immediately. BetterAuth caches sessions in Redis;
    // those entries expire on TTL and are non-load-bearing.
    await tx.session.deleteMany({ where: { userId } });
    await tx.account.deleteMany({ where: { userId } });

    // Audit row (under SYSTEM — the actor is the platform, the target
    // is the user). One row per affected org so per-org audit pulls
    // see the event.
    for (const orgId of affectedOrganizationIds) {
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          category: "SYSTEM",
          action: AUDIT_ACTIONS.SYSTEM.USER_ERASURE_PROCESSED,
          description: `Erased user ${pseudonymousId.slice(0, 12)} per DPDP §12`,
          details: { pseudonymousId, erasedAt: now.toISOString() },
        },
      });

      // Fan webhook events so SCIM + integrators see the deprovisioning.
      // The data payload uses pseudonymousId — never the raw userId or
      // email — to keep with the erasure semantics.
      await dispatchWebhookEvent({
        prisma: tx,
        organizationId: orgId,
        eventType: "member.removed",
        payload: {
          membershipId: memberships
            .filter((m) => m.organizationId === orgId)
            .map((m) => m.id)[0],
          pseudonymousId,
          source: "dpdp_erasure",
          erasedAt: now.toISOString(),
        },
      });
    }
  });

  // Stream revocation is best-effort after commit, as in the moderation
  // side-effects; the rows are REMOVED either way. #1593 — each attempt
  // settles its outbox row: SUCCEEDED here, or FAILED with the first retry
  // slot for the sweep to pick up.
  for (const { planType, planId } of collaborationsRemoved) {
    let error: string | null = null;
    try {
      // Lazy: the service pulls Stream and Novu, which the scrub does not need
      // unless a collaboration was actually flipped.
      const { revokeCollaboratorAccess } =
        await import("@/lib/collaborators/service");
      const { success } = await revokeCollaboratorAccess(
        planType,
        planId,
        userId,
        { notify: false },
      );
      if (!success) error = "Collaborator Stream access not fully revoked";
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    if (error) {
      reportSentryError(new Error(`${error} on erasure`), {
        subsystem: "compliance",
        op: "scrubUser.revokeCollaboratorAccess",
        extra: { planType, planId },
      });
    }
    if (!erasureRequestId) continue;
    await prisma.streamRevocationRetry
      .update({
        where: {
          erasureRequestId_planType_planId: {
            erasureRequestId,
            planType: planType === "webinar" ? "WEBINAR" : "CLASS",
            planId,
          },
        },
        data: error
          ? {
              status: "FAILED",
              attempts: 1,
              lastError: error,
              nextRetryAt: nextRetryAt(1, now),
            }
          : { status: "SUCCEEDED", attempts: 1, completedAt: new Date() },
      })
      .catch((caught) =>
        reportSentryError(caught, {
          subsystem: "compliance",
          op: "scrubUser.settleRevocationOutbox",
          extra: { planType, planId },
        }),
      );
  }

  return { scrubbed: true, pseudonymousId, affectedOrganizationIds };
}
