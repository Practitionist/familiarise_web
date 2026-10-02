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
 *   StreamRevocationRetry → one row per subject for the principal leg above,
 *     plus one per flipped collaboration, all written in the scrub transaction
 *   ConsultantProfile.headline / videoIntroUrl → NULL, deletedAt → now()
 *   ConsulteeProfile.goals → NULL (#1598 P4-P0-05)
 *   Trial.notes and Consultation.requestNotes the consultee wrote → NULL
 *
 *   BetterAuth Session + Account rows → hard-deleted (forces sign-out
 *   across every device immediately; SSO accounts are dropped too).
 *
 *   Stream (the PRINCIPAL leg — the subject's identity itself, owed by every
 *   erasure and owed unconditionally):
 *     User name / email / image on Stream → hard-deleted
 *     Every message the subject wrote      → hard-deleted
 *     Every chat token minted before now  → revoked
 *   run AFTER the transaction commits, from a `StreamRevocationRetry` outbox
 *   row written INSIDE it. This leg used not to exist for anyone without a
 *   consultant collaborator row: `removeCollaboratorStanding` returns `[]` for a
 *   subject with no ConsultantProfile (and for one holding no PENDING/ACCEPTED
 *   collaborator row), so a consultee — or a consultant who never sat on a plan
 *   — committed with no Stream obligation recorded, Stream kept their name,
 *   email, image and every message they ever wrote, `USER_ERASURE_PROCESSED`
 *   was written, and `vendorFailures` came back empty. That is a false
 *   attestation, not a transient failure: nothing alerted and nothing retried.
 *   `scripts/stream/stream-sync.ts` does not compensate — it only soft-deletes
 *   users ABSENT from the database, and an erased user is still present.
 *
 *   PayoutAccount holder name, bank name, last-4, IFSC and UPI id → NULL;
 *   the RazorpayX fund account and contact are deactivated, and the
 *   buyer's Razorpay saved-card tokens are deleted (#1771 rows 1 and 5).
 *
 * What survives intact (per Indian IT Act §44AA / §92 retention rules
 * and per the financial-records carve-out in DPDP §12):
 *
 *   Payment*, OrganizationInvoice, OrganizationPayout,
 *   WalletEntry, FundingLedgerEntry, SettlementLedgerEntry, Refund,
 *   ConsultantPayout, TDSRecord, and the PayoutAccount rzp ids those rows
 *   reference. Two retention clocks govern them: Income-tax Rule 6F(5)
 *   keeps books for six years from the end of the relevant assessment
 *   year, and CGST Act s.36 keeps GST records for seventy-two months from
 *   the due date of that year's annual return.
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
 * `pseudonymousId` without writing. The VENDOR legs are still re-attempted —
 * the Novu subscriber and now the Stream principal leg — because "already done"
 * is per-side-effect and not per-function: a guard written for the database
 * commit says nothing about whether a processor was ever reached.
 *
 * Webhook fan-out
 * ---------------
 * Emits `member.removed` per affected organization so
 * webhook-subscribed downstreams see the deprovisioning. The
 * dispatching is fire-and-forget inside the same transaction so a
 * rollback (e.g. constraint violation we didn't anticipate) takes the
 * webhook rows with it.
 *
 * Stream audit trail
 * ------------------
 * `USER_ERASURE_PROCESSED` alone reads as "the subject is gone", which is a
 * claim about four systems, not one. The audit row's `details.streamRevocation`
 * therefore names the outbox row carrying the Stream obligation
 * (`principalTaskId`) plus every collaboration key, so an auditor can follow
 * the id to `StreamRevocationRetry` and read the LIVE status instead of
 * inferring one. `principalTaskId: null` means no `ErasureRequest` anchored an
 * outbox row on this path — the obligation is attempted but not durably
 * tracked, which is itself recorded rather than smoothed over.
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
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";

export interface ScrubResult {
  /// True iff this call performed the scrub. False means the user was
  /// already erased on a prior call (idempotency path).
  scrubbed: boolean;
  pseudonymousId: string;
  affectedOrganizationIds: string[];
  /**
   * Every vendor leg this run could not settle, in the order it was attempted.
   * Each entry says WHICH processor and WHICH obligation, and is the only thing
   * standing between an unlanded deletion and a clean `USER_ERASURE_PROCESSED`.
   * An empty array means every leg was confirmed — including "not configured",
   * which is reported as a failure because an unconfigured runtime cannot
   * confirm anything (see offboardNotificationVendor).
   */
  vendorFailures: string[];
  /**
   * The `StreamRevocationRetry` row for this subject's Stream IDENTITY
   * (`{prefix}{userId}`), or null when no `ErasureRequest` anchors an outbox
   * row on this path. Present so a caller can read the row's live status; its
   * presence is not a claim that the deletion landed.
   */
  streamPrincipalOutboxId: string | null;
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
  /** ConsultantEarnings not yet paid out — every non-terminal status matures into money owed. */
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
          status: {
            in: ["PENDING", "PENDING_TRUST", "HELD", "READY", "BATCHED"],
          },
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

/**
 * Delete the user's Novu subscriber, and be honest about what that proves.
 *
 * `deleteSubscriber` never throws and never rejects. It resolves `true` both
 * when the remote delete succeeded AND when Novu is not configured at all —
 * the two are indistinguishable from its return value, and that is the trap: a
 * deployment that lost `NOVU_KEY` would report a clean erasure while an earlier
 * deployment's subscriber still held the email address and push tokens.
 *
 * So "not configured" is checked here rather than inferred. It is reported as
 * a failure because that is what it is: the vendor copy is of unknown state,
 * and an erasure that cannot confirm a processor's copy is gone has not
 * discharged its duty.
 *
 * Re-runnable by design: Novu deletion is idempotent, so calling this again on
 * an already-erased user is the retry path for a previously unconfirmed delete.
 *
 * `DELETE /api/user/[id]` has the same "not configured" conflation in its
 * `novuCleanup: "done"` field. It is left alone here because the fix belongs in
 * `deleteSubscriber`'s contract rather than in each caller, and changing that
 * return type is a wider change than a hotfix should carry.
 */
async function offboardNotificationVendor(userId: string): Promise<string[]> {
  const { isNovuConfigured } = await import("@/lib/novu/client");
  if (!isNovuConfigured()) {
    return [
      "novu: not configured in this runtime — cannot confirm the vendor copy " +
        "was deleted; verify manually and re-run once NOVU_KEY is restored",
    ];
  }
  const { deleteSubscriber } = await import("@/lib/novu/subscriber");
  if (await deleteSubscriber(userId)) return [];
  return ["novu: subscriber deletion not confirmed — re-run required"];
}

/** True when any money-in-flight count is non-zero. */
export function hasMoneyInFlight(counts: MoneyInFlight): boolean {
  return Object.values(counts).some((n) => n > 0);
}

/**
 * Reserved `StreamRevocationRetry.planId` namespace for the PRINCIPAL leg —
 * deleting the subject's Stream identity and their messages, which owes Stream
 * nothing about any plan.
 *
 * `StreamRevocationRetry` is plan-shaped: `planType` is `CollaboratorType` and
 * `@@unique([erasureRequestId, planType, planId])` is built around a plan. The
 * principal obligation is therefore addressed through a reserved namespace
 * rather than a schema change nobody owns. Two properties make the address
 * safe:
 *
 *  - Every real plan id is a cuid, and this one starts with `principal:`, so
 *    the principal row can never collide with a plan's own revocation row for
 *    the same erasure request.
 *  - `planType` is `CLASS` because that is what the retry driver's
 *    `planType === "WEBINAR" ? "webinar" : "class"` mapping carries. It is a
 *    naming choice, not a claim that a class plan exists — see
 *    PRINCIPAL_OUTBOX_SWEEP_PARK_MS for what the driver does with it.
 */
export const STREAM_PRINCIPAL_PLAN_ID_PREFIX = "principal:";

/** The plan-addressed outbox key for the principal leg. */
export function principalStreamPlanId(userId: string): string {
  return `${STREAM_PRINCIPAL_PLAN_ID_PREFIX}${userId}`;
}

/**
 * Deterministic PRIMARY KEY for that row.
 *
 * `createMany` returns a count, not rows, and the audit row has to name this
 * row so an auditor can trace it. Deriving the id from the subject means the
 * pointer is known without a read-back and stays stable across a re-drive, so
 * an operator tracing the audit trail reaches the same row every time.
 *
 * Safe as a primary key because `scrubUser` reaches its transaction at most
 * once per subject: every later call observes `erasedAt` and takes the
 * idempotent path below. Two rows for one subject therefore cannot be created,
 * and `skipDuplicates` covers the case where an earlier run committed the row
 * and then died before the vendor calls.
 */
export function streamPrincipalOutboxId(userId: string): string {
  return `stream-principal-revocation:${userId}`;
}

/**
 * A principal outbox row left FAILED is parked here rather than given an
 * ordinary backoff slot, and the reason is a defect in the drain, not a
 * preference.
 *
 * `drainErasureRevocations` in `scripts/cleanup/retry-moderation-enforcement.ts`
 * re-drives EVERY PENDING/FAILED row through
 * `revokeCollaboratorAccess(planType, planId, userId)`. For a principal row
 * that call addresses a plan which never existed, and it resolves
 * `{ success: true }`: the `classPlanId` filters match zero rows, the
 * participant transition is a no-op, and the `collab-class-principal:<id>`
 * channel 404s into `isExpectedStreamError` and is swallowed. So with an
 * ordinary `nextRetryAt(1, now)` the sweep stamps `SUCCEEDED` on the row
 * within a minute — and Stream still holds the subject's name, email and every
 * message they wrote. The sweep would manufacture exactly the false
 * attestation this leg exists to remove, one cron later, and the operator
 * reading the outbox would have no way to tell.
 *
 * Parking the row past any sweep window keeps the record truthful: it stays
 * FAILED, indexed on `[status, nextRetryAt]`, with the reason in `lastError`,
 * and it is re-driven by `scrubUser`'s own idempotent path — the same
 * re-attempt mechanism the Novu leg already uses, and the only one that
 * actually performs the deletion. An operator re-running the erasure is the
 * repair.
 *
 * TODO: teach `drainErasureRevocations` to branch on
 * STREAM_PRINCIPAL_PLAN_ID_PREFIX and re-drive the principal leg instead of the
 * plan-shaped call. Once it does, this becomes `nextRetryAt(attempts, now)` like
 * every other row and the manual re-run is no longer required.
 */
const PRINCIPAL_OUTBOX_SWEEP_PARK_MS = 100 * 365 * 24 * 3_600_000;

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
      razorpayCustomerId: true,
    },
  });
  if (!existing) {
    throw Object.assign(new Error("User not found"), { httpStatus: 404 });
  }
  if (existing.erasedAt && existing.pseudonymousId) {
    // Idempotency for the LOCAL scrub: the pseudonymous row is already
    // committed, so there is nothing left to rewrite here. Return the existing
    // pseudonym so callers can still react (e.g. audit "we processed the
    // request" for compliance trail).
    //
    // The VENDOR legs are still re-attempted. They are idempotent, and a
    // previous run may have failed to reach a processor — a network error, a
    // credential that was briefly wrong, or a Novu deployment that had lost
    // its key. Returning `vendorFailures: []` here without retrying meant a
    // transient failure was permanent: re-running the erasure reported a
    // clean success and the processor kept the data forever. This is the
    // retry path for exactly that — and for the Stream principal leg it is the
    // ONLY retry path (see PRINCIPAL_OUTBOX_SWEEP_PARK_MS).
    //
    // Payment vendors are NOT re-attempted: they are guarded by the cleared
    // `razorpayCustomerId`, so a second pass has nothing to act on.
    //
    // One read, not two: the principal outbox row's id is derived from the
    // subject, so whether one exists and how many attempts it has already had
    // come back together.
    const principalRow = await prisma.streamRevocationRetry
      .findUnique({
        where: { id: streamPrincipalOutboxId(userId) },
        select: { id: true, attempts: true },
      })
      .catch(() => null);

    return {
      scrubbed: false,
      pseudonymousId: existing.pseudonymousId,
      affectedOrganizationIds: [],
      streamPrincipalOutboxId: principalRow?.id ?? null,
      vendorFailures: [
        ...(await eraseStreamPrincipalFootprint(prisma, {
          userId,
          now: new Date(),
          outboxTaskId: principalRow?.id ?? null,
          attempts: principalRow?.attempts ?? 0,
        })),
        ...(await offboardNotificationVendor(userId)),
      ],
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
  // #1771 row 5 — bank data is reference-only: the rzp ids stay for the
  // payout and TDS rows, and the vendor objects are deactivated after commit.
  const payoutAccounts = await prisma.payoutAccount.findMany({
    where: { consultantProfile: { userId } },
    select: { id: true, razorpayContactId: true, razorpayFundAccId: true },
  });

  let collaborationsRemoved: CollaborationRef[] = [];
  let erasureRequestId: string | null = null;
  let principalOutboxTaskId: string | null = null;
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
        now,
      );
    }

    if (payoutAccounts.length > 0) {
      await tx.payoutAccount.updateMany({
        where: { id: { in: payoutAccounts.map((a) => a.id) } },
        data: {
          accountHolderName: null,
          bankName: null,
          accountNumberLast4: null,
          ifscCode: null,
          upiId: null,
        },
      });
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

    // …and the PRINCIPAL row: ONE per subject, not one per collaboration.
    // Everything above is conditional on the subject holding collaborator rows,
    // and `removeCollaboratorStanding` returns `[]` for anyone without a
    // ConsultantProfile as well as for anyone holding no PENDING/ACCEPTED row.
    // So a consultee reached this commit having recorded no Stream obligation
    // at all — the whole Stream footprint survived, and the run reported clean.
    //
    // Its own `createMany` rather than an extra element on the one above,
    // because that call's shape is asserted by the #1580 collaborator
    // coverage and a row that can be absent for most subjects must not be
    // riding along inside a `collaborationsRemoved.length > 0` branch.
    if (erasureRequestId) {
      principalOutboxTaskId = streamPrincipalOutboxId(userId);
      await tx.streamRevocationRetry.createMany({
        data: [
          {
            id: principalOutboxTaskId,
            erasureRequestId,
            planType: "CLASS",
            planId: principalStreamPlanId(userId),
          },
        ],
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
          details: {
            pseudonymousId,
            erasedAt: now.toISOString(),
            // What Stream still owes. `USER_ERASURE_PROCESSED` is a claim
            // about the database; this is the claim about Stream, addressed by
            // something an auditor can open. `principalTaskId` names the
            // StreamRevocationRetry row for the subject's Stream IDENTITY, so
            // its LIVE status is one query away; null means no ErasureRequest
            // anchored a row on this path and the obligation is not durably
            // tracked. `collaborations` are the same table keyed by
            // (erasureRequestId, planType, planId).
            streamRevocation: {
              principalTaskId: principalOutboxTaskId,
              principalPlanId: principalStreamPlanId(userId),
              collaborations: collaborationsRemoved.map(
                ({ planType, planId }) => ({ planType, planId }),
              ),
            },
          },
        },
      });

      // Fan webhook events so integrators see the deprovisioning.
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

  // The PRINCIPAL leg — after commit, like every vendor call above. Its outbox
  // row was written inside the transaction, so a process death between the two
  // leaves a recorded debt rather than a silent one.
  const streamPrincipalFailures = await eraseStreamPrincipalFootprint(prisma, {
    userId,
    now,
    outboxTaskId: principalOutboxTaskId,
  });

  const vendorFailures = [
    ...streamPrincipalFailures,
    ...(await offboardPaymentVendors(prisma, {
      userId,
      razorpayCustomerId: existing.razorpayCustomerId,
      payoutAccounts,
    })),
    ...(await offboardNotificationVendor(userId)),
  ];

  return {
    scrubbed: true,
    pseudonymousId,
    affectedOrganizationIds,
    streamPrincipalOutboxId: principalOutboxTaskId,
    vendorFailures,
  };
}

/**
 * The response shape `chat.deleteUsers` actually answers with.
 *
 * The SDK types it as `APIResponse & TaskResponse` — a background `task_id` and
 * nothing about the users. Stream may ALSO report per-user failures inline
 * alongside the task id, which is what `scripts/stream/stream-sync.ts` reads
 * through a cast. Reading it is the difference between "the call resolved" and
 * "the deletion happened": the second is the only one that discharges the duty,
 * so a batch that resolves with a failed entry must not settle the outbox row.
 */
interface StreamDeleteUsersResponse {
  task_id?: string;
  failed_delete_users?: { user_id: string; message?: string }[];
}

/**
 * The Stream PRINCIPAL leg: erase the subject's identity and everything they
 * wrote, and be honest about whether it happened.
 *
 * Runs AFTER the local transaction commits — never inside it, because a Stream
 * call cannot be rolled back and the scrub's transaction holds a row lock on
 * the subject. The obligation is durable before the attempt (the outbox row is
 * written in the transaction), so this function's job is to settle that row and
 * to tell the truth: every entry it returns is a processor still holding data,
 * and an empty return is a claim that Stream was reached and complied.
 *
 * ## The two calls, and why this order
 *
 * `revokeUserToken(userId, new Date())` first. It sets
 * `revoke_tokens_issued_before = now`, so every token minted before this
 * instant stops working — the same revocation the moderation ban applies, and
 * the reason the access is already cut even if the delete below then fails.
 * Running it first means the failure mode of the delete is "the data is still
 * there", not "the subject can still talk".
 *
 * `deleteUsers([userId], { user: "hard", messages: "hard" })` second.
 * `user: "hard"` removes the user object — the name, email and image Stream
 * holds. `messages: "hard"` removes what they wrote. Soft mode would keep all
 * of it for Stream's 30-day grace window, and a grace window is not ours to
 * grant for someone who has asked to be erased.
 *
 * Deliberately NOT `conversations: "hard"`: channels are shared artefacts
 * holding other members' messages, a hard conversation delete needs a
 * `new_channel_owner_id` we have no basis to nominate, and the collaborator
 * rows above already strip the subject from every plan channel.
 *
 * ## DeleteUsers is 6/minute, and this design cannot storm it
 *
 * Verified against the live app (Stream's own `rateLimit` metadata on
 * DeleteUsers: limit 6). Two structural properties hold it under the ceiling:
 *
 *  1. ONE request, ONE id. `scrubUser` handles exactly one subject, so the
 *     array is a literal singleton and there is nothing to chunk. The usual way
 *     a bulk endpoint gets stormed — a loop fanning ids across concurrent
 *     calls — is structurally absent here rather than merely avoided, and
 *     `Promise.all` appears nowhere on this path.
 *  2. A 429 is a RETRY, never a success. `withStreamCircuitBreaker` already
 *     exempts 429 from tripping the breaker and from Sentry (quota is not
 *     availability), and this leg turns the rejection into a FAILED outbox row
 *     plus a `vendorFailures` entry naming the quota. Reaching the ceiling
 *     therefore makes the erasure honest and retriable; it can never make it
 *     silently drop the obligation.
 *
 * Erasures are operator-initiated and money-gated (`ERASURE_BLOCKED_MONEY_IN_FLIGHT`),
 * so the inbound rate is human. If a bulk-erasure sweep is ever built it MUST
 * pace at ≥10s per DeleteUsers call — `lib/stream/batch.ts` holds the repo's
 * pacing convention — and must not assume it shares the `revokeUserToken`
 * budget.
 */
async function eraseStreamPrincipalFootprint(
  prisma: Db,
  input: {
    userId: string;
    now: Date;
    /** The outbox row, or null when no ErasureRequest anchors one. */
    outboxTaskId: string | null;
    /** Attempts already recorded, so a re-drive advances the count. */
    attempts?: number;
  },
): Promise<string[]> {
  const { userId, now, outboxTaskId } = input;
  const attempts = (input.attempts ?? 0) + 1;
  const failures: string[] = [];
  const asError = (caught: unknown) =>
    caught instanceof Error ? caught : new Error(String(caught));

  try {
    // Lazy: lib/stream-client constructs the Redis-backed breaker at import
    // time, and most of this module's importers must not pay for that.
    const {
      getStreamChatClient,
      isRateLimitError,
      isStreamConfigured,
      withStreamCircuitBreaker,
    } = await import("@/lib/stream-client");

    if (!isStreamConfigured()) {
      // The Novu leg's doctrine, applied here: "we could not ask" is not "we
      // asked and it worked". A deployment that lost its Stream keys cannot
      // confirm the processor's copy is gone, and an erasure that cannot
      // confirm that has not discharged its duty.
      failures.push(
        "stream_identity: not configured in this runtime — cannot confirm the " +
          "Stream copy was deleted; restore NEXT_PUBLIC_STREAM_API_KEY/" +
          "STREAM_API_SECRET and re-run the erasure",
      );
    } else {
      const chat = getStreamChatClient();
      try {
        await withStreamCircuitBreaker(() =>
          chat.revokeUserToken(userId, new Date()),
        );
      } catch (caught) {
        failures.push(
          describeStreamFailure(
            "stream_token_revocation",
            caught,
            isRateLimitError(caught),
            outboxTaskId,
          ),
        );
        reportSentryError(asError(caught), {
          subsystem: "compliance",
          op: "scrubUser.revokeStreamToken",
          extra: { userId, outboxTaskId },
        });
      }

      let response: StreamDeleteUsersResponse | undefined;
      try {
        await withStreamCircuitBreaker(async () => {
          response = (await chat.deleteUsers([userId], {
            user: "hard",
            messages: "hard",
          })) as StreamDeleteUsersResponse;
        });
      } catch (caught) {
        failures.push(
          describeStreamFailure(
            "stream_identity_delete",
            caught,
            isRateLimitError(caught),
            outboxTaskId,
          ),
        );
        reportSentryError(asError(caught), {
          subsystem: "compliance",
          op: "scrubUser.deleteStreamUser",
          extra: { userId, outboxTaskId },
        });
      }

      if (response) {
        // The vendor-side handle for an operator: Stream answers a batch delete
        // with a background task id. It is not a confirmation — the sweep runs
        // the work — so it is recorded, never used to settle the row.
        if (response.task_id) {
          reportSentryError(
            new Error(`Stream deletion accepted for erased user ${userId}`),
            {
              subsystem: "compliance",
              op: "scrubUser.deleteStreamUser",
              expected: true,
              extra: { userId, streamTaskId: response.task_id, outboxTaskId },
            },
          );
        }
        // …and an inline failure means the deletion did NOT happen even though
        // the call resolved, which is the case a try/catch alone would miss.
        const refused = (response.failed_delete_users ?? []).filter(
          (failure) => failure.user_id === userId,
        );
        if (refused.length > 0) {
          failures.push(
            "stream_identity_delete: Stream accepted the request but reported " +
              `the delete as failed for this user (${refused
                .map((f) => f.message ?? "no reason given")
                .join("; ")})`,
          );
        }
      }
    }
  } catch (caught) {
    // The Stream module graph itself failed to load — its Redis breaker needs
    // credentials. Reported rather than swallowed, so a missing import can
    // never present as a clean erasure.
    failures.push(
      `stream_identity: could not reach Stream at all — ${
        caught instanceof Error ? caught.message : String(caught)
      }`,
    );
    reportSentryError(asError(caught), {
      subsystem: "compliance",
      op: "scrubUser.loadStreamClient",
      extra: { userId, outboxTaskId },
    });
  }

  if (outboxTaskId) {
    try {
      await prisma.streamRevocationRetry.update({
        where: { id: outboxTaskId },
        data:
          failures.length === 0
            ? { status: "SUCCEEDED", attempts, completedAt: new Date() }
            : {
                status: "FAILED",
                attempts,
                lastError: failures.join(" | "),
                nextRetryAt: new Date(
                  now.getTime() + PRINCIPAL_OUTBOX_SWEEP_PARK_MS,
                ),
              },
      });
    } catch (caught) {
      // A lost settlement is not a bookkeeping detail: it leaves the row
      // PENDING while this function reports nothing, which is the same
      // false attestation the leg exists to remove.
      failures.push(
        `stream_outbox_settle: the Stream obligation could not be recorded against ${outboxTaskId} — ${
          caught instanceof Error ? caught.message : String(caught)
        }`,
      );
      reportSentryError(asError(caught), {
        subsystem: "compliance",
        op: "scrubUser.settlePrincipalOutbox",
        extra: { userId, outboxTaskId },
      });
    }
  } else if (failures.length > 0) {
    failures.push(
      "stream_identity: no ErasureRequest anchors a StreamRevocationRetry row " +
        "for this subject, so nothing on the outbox records what is still owed " +
        "to Stream — only a re-run of this erasure can retry it",
    );
  }

  return failures;
}

/** Names the step, the reason, and — for a throttle — the quota that refused. */
function describeStreamFailure(
  step: string,
  caught: unknown,
  throttled: boolean,
  outboxTaskId: string | null,
): string {
  if (throttled) {
    return (
      `${step}: Stream refused on the DeleteUsers quota (6/minute — a quota, ` +
      `not an outage, so this deliberately does not page); still owed on ` +
      `outbox row ${outboxTaskId ?? "none"}`
    );
  }
  return `${step}: ${caught instanceof Error ? caught.message : String(caught)}`;
}

/**
 * #1771 rows 1 and 5 — after commit, like the Stream revocations: delete the
 * buyer's saved-card tokens, then deactivate every RazorpayX fund account and
 * contact. A failure never aborts the scrub; it becomes a system event and a
 * `vendorFailures` entry. The Customer column is cleared only once its tokens
 * are gone and its PII is overwritten, so the reference survives for a retry.
 */
async function offboardPaymentVendors(
  prisma: Db,
  input: {
    userId: string;
    razorpayCustomerId: string | null;
    payoutAccounts: {
      razorpayContactId: string | null;
      razorpayFundAccId: string | null;
    }[];
  },
): Promise<string[]> {
  const failures: string[] = [];
  const attempt = async (step: string, run: () => Promise<unknown>) => {
    try {
      await run();
      return true;
    } catch (err) {
      failures.push(step);
      await recordSystemErrorSafe({
        category: "COMPLIANCE",
        summary: `Erasure could not complete ${step}`,
        err,
        context: { userId: input.userId, step },
      });
      return false;
    }
  };

  const customerId = input.razorpayCustomerId;
  if (customerId) {
    const razorpay = await import("@/lib/payments/core/razorpay");
    const deleted = await attempt(`razorpay_tokens:${customerId}`, () =>
      razorpay.deleteRazorpayCustomerTokens(customerId),
    );
    // Owner decision 2026-09-25 — the Customer cannot be deleted, so its PII is overwritten.
    const overwritten =
      deleted &&
      (await attempt(`razorpay_customer_pii:${customerId}`, () =>
        razorpay.eraseRazorpayCustomerPii(customerId, input.userId),
      ));
    if (overwritten) {
      await attempt("razorpay_customer_column", () =>
        prisma.user.update({
          where: { id: input.userId },
          data: { razorpayCustomerId: null },
        }),
      );
    }
  }

  const fundAccountIds = input.payoutAccounts.flatMap((a) =>
    a.razorpayFundAccId ? [a.razorpayFundAccId] : [],
  );
  const contactIds = Array.from(
    new Set(
      input.payoutAccounts.flatMap((a) =>
        a.razorpayContactId ? [a.razorpayContactId] : [],
      ),
    ),
  );
  if (fundAccountIds.length === 0 && contactIds.length === 0) return failures;

  const { getRazorpayPayoutsService } =
    await import("@/lib/payments/payouts/razorpay-payouts");
  for (const id of fundAccountIds) {
    await attempt(`razorpayx_fund_account:${id}`, () =>
      getRazorpayPayoutsService().deactivateFundAccount(id),
    );
  }
  for (const id of contactIds) {
    await attempt(`razorpayx_contact:${id}`, () =>
      getRazorpayPayoutsService().deactivateContact(id),
    );
  }
  return failures;
}
