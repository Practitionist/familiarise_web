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
 *   SessionAccessLog.userId → NULL; IP, user agent and times stay until the
 *   180-day prune (CERT-In Directions, a legal obligation under DPDP s.17).
 *
 *   NewsletterSubscriber rows (by userId or address) → deleted. Queued
 *   FailedEmail rows → DEAD_LETTER `policy:recipient_erased`, subject and
 *   bodies redacted; every FailedEmail row's recipient → an `erased:` digest;
 *   every FailedEmailBatch loses the address. EmailSuppression stays so the
 *   address remains unmailable.
 *
 *   AppointmentWaitlist and WindowBackupInterest rows → deleted.
 *   Referral.ipHash and userAgent of the referred user → NULL.
 *
 *   PayoutAccount holder name, bank name, last-4, IFSC and UPI id → NULL;
 *   the RazorpayX fund account and contact are deactivated, and the
 *   buyer's Razorpay saved-card tokens are deleted (#1771 rows 1 and 5).
 *
 * What survives intact (per Indian IT Act §44AA / §92 retention rules
 * and per the financial-records carve-out in DPDP §12):
 *
 *   Payment* (payerVpaHash and payerPhoneHash too, until their two-year
 *   window), OrganizationInvoice, OrganizationPayout,
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
 * `pseudonymousId` without writing. Safe to call multiple times.
 *
 * Webhook fan-out
 * ---------------
 * Emits `member.removed` per affected organization so
 * webhook-subscribed downstreams see the deprovisioning. The
 * dispatching is fire-and-forget inside the same transaction so a
 * rollback (e.g. constraint violation we didn't anticipate) takes the
 * webhook rows with it.
 */

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Db } from "@/lib/prisma";
import {
  purgeDigitalProductSurfaces,
  purgeRecordingSurfaces,
  purgeReviewSurfaces,
} from "@/lib/data/public-cache";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { revokeAllUserSessions } from "@/lib/auth/session-revoke";
import {
  detachSessionAccessLogs,
  stampSessionEnds,
  type EndedSessions,
} from "@/lib/auth/session-access-log";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";
import { releaseSeatsForTerminatedAssignments } from "@/lib/api/organizations/seat-count";
import { endCollaborationsForUser } from "@/lib/collaborators/ending";
import { sendOwedCohostEmails } from "@/lib/collaborators/notifications";
import type { PlanRef } from "@/lib/collaborators/team";
import type { OwedCohostEmails } from "@/lib/email/senders/collaborators";
import { reportSentryError } from "@/lib/observability/report";
import {
  createRunFailureReporter,
  type RunFailureReporter,
} from "@/lib/observability/run-failures";
import { scrubStringValue } from "@/lib/observability/sentry-scrubber";
import { nextRetryAt } from "@/lib/retry/backoff";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";
import { liveParticipant, paidParticipant } from "@/lib/booking/participants";
import { LIVE_SLOT_WHERE } from "@/lib/booking/cancellation-scope";
import { eraseUserSessionDocuments } from "@/lib/documents/document-erasure";
import {
  purgeErasedCreatorFiles,
  scrubDigitalProductsTx,
} from "@/lib/digital-products/erasure";
import { scrubMailFootprintTx } from "./mail-footprint";
import { NULLED_REFERRAL_SIGNALS } from "@/lib/compliance/signal-retention";
import {
  removeSupportAttachmentObjects,
  scrubSupportPiiTx,
  supportAttachmentPaths,
} from "@/lib/support/erasure";

export interface ScrubResult {
  /// True iff this call performed the scrub. False means the user was
  /// already erased on a prior call (idempotency path).
  scrubbed: boolean;
  pseudonymousId: string;
  affectedOrganizationIds: string[];
  /// #1771 row 5 — Razorpay/RazorpayX steps that failed; each is also a system event.
  vendorFailures: string[];
}

/**
 * Deterministic pseudonym derivation. The salt is read at call time
 * so the `ERASURE_SALT` env can be rotated without code change in an
 * emergency — old erasures are NOT re-keyed (their pseudonymousId is
 * locked in at scrub time and stored on the User row).
 */
export function derivePseudonym(userId: string): string {
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
  const [consultantPayouts, unsettledEarnings, liveDisputes, soleOwned] =
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
      soleOwnedOrganizations(db, userId, { includeInactive: true }),
    ]);

  const orgInvoicesAsSoleOwner =
    soleOwned.length > 0
      ? await db.organizationInvoice.count({
          where: {
            organizationId: { in: soleOwned.map((o) => o.id) },
            status: { in: ["ISSUED", "OVERDUE"] },
          },
        })
      : 0;

  return {
    consultantPayouts,
    unsettledEarnings,
    orgInvoicesAsSoleOwner,
    liveDisputes,
  };
}

export interface LiveBookings {
  /** Consultations still pending, approved or awaiting payment. */
  activeConsultations: number;
  /** Plans still pending, approved or awaiting payment. */
  activeSubscriptions: number;
  /** Trials scheduled or awaiting payment. */
  activeTrials: number;
  /** Class or webinar seats on an event with a session ahead or under way. */
  activeEventSeats: number;
}

const ACTIVE_BOOKING_STATUSES = [
  "PENDING",
  "APPROVED",
  "APPROVED_PENDING_PAYMENT",
] as const;

/**
 * Bookings the user still holds as a learner. Erasure never cancels a booking:
 * the self-serve delete and the admin process route both refuse with
 * ERASURE_BLOCKED_ACTIVE_BOOKINGS until each is cancelled or left through its
 * own door, because a scrubbed learner cannot sign in to attend or cancel.
 */
export async function liveBookingsForUser(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<LiveBookings> {
  const [
    activeConsultations,
    activeSubscriptions,
    activeTrials,
    activeEventSeats,
  ] = await Promise.all([
    db.consultation.count({
      where: {
        requestedBy: { userId },
        status: { in: [...ACTIVE_BOOKING_STATUSES] },
      },
    }),
    db.subscription.count({
      where: {
        requestedBy: { userId },
        status: { in: [...ACTIVE_BOOKING_STATUSES] },
      },
    }),
    db.trial.count({
      where: {
        consulteeProfile: { userId },
        status: { in: ["SCHEDULED", "AWAITING_PAYMENT"] },
      },
    }),
    db.appointment.count({
      where: {
        deletedAt: null,
        OR: [{ webinarId: { not: null } }, { classId: { not: null } }],
        participants: {
          some: { ...paidParticipant(userId), role: "CONSULTEE" },
        },
        // Until the session ends: a learner in a session under way is still seated.
        occurrences: { some: { ...LIVE_SLOT_WHERE, endsAt: { gt: now } } },
      },
    }),
  ]);
  return {
    activeConsultations,
    activeSubscriptions,
    activeTrials,
    activeEventSeats,
  };
}

/** True when the user still holds any live booking. */
export function hasLiveBookings(counts: LiveBookings): boolean {
  return Object.values(counts).some((n) => n > 0);
}

/** The live bookings in words, for a refusal: "1 plan, 2 class or webinar seats". */
export function describeLiveBookings(counts: LiveBookings): string {
  const part = (n: number, one: string, many: string) =>
    n > 0 ? [`${n} ${n === 1 ? one : many}`] : [];
  return [
    ...part(counts.activeConsultations, "consultation", "consultations"),
    ...part(counts.activeSubscriptions, "plan", "plans"),
    ...part(counts.activeTrials, "trial", "trials"),
    ...part(
      counts.activeEventSeats,
      "class or webinar seat",
      "class or webinar seats",
    ),
  ].join(", ");
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
export async function offboardNotificationVendor(
  userId: string,
): Promise<string[]> {
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

export const STREAM_PRINCIPAL_PLAN_ID_PREFIX = "principal:";
export function principalStreamPlanId(userId: string): string {
  return `${STREAM_PRINCIPAL_PLAN_ID_PREFIX}${userId}`;
}

export async function eraseStreamPrincipalFootprint(
  userId: string,
): Promise<void> {
  const { getStreamChatClient, isExpectedStreamError, isStreamConfigured } =
    await import("@/lib/stream-client");
  if (!isStreamConfigured()) {
    throw new Error(
      "Stream is not configured — cannot confirm principal deletion",
    );
  }

  const chat = getStreamChatClient();
  try {
    await chat.revokeUserToken(userId, new Date());
  } catch (err) {
    if (!isExpectedStreamError(err)) throw err;
  }

  try {
    await chat.deleteUsers([userId], { user: "hard", messages: "hard" });
  } catch (err) {
    if (!isExpectedStreamError(err)) throw err;
  }
}

async function deleteStreamRecordingCopy(rec: {
  streamCallId: string | null;
  streamRecordingId: string | null;
}): Promise<boolean> {
  const { deleteStreamRecordingCopy: remove } =
    await import("@/lib/stream/recording-stream-delete");
  const result = await remove(rec);
  return result.success;
}

async function purgeSingleUserRecordingOnErasure(
  db: Db,
  recordingId: string,
  eligible: Prisma.RecordingWhereInput,
  now: Date,
  vendorFailures: RunFailureReporter,
): Promise<void> {
  // Stop transfer publication and capture the assets from the same row version.
  const claimSelect = {
    id: true,
    storagePath: true,
    previewClipStoragePath: true,
    streamCallId: true,
    streamRecordingId: true,
    removedAt: true,
  } satisfies Prisma.RecordingSelect;
  // A live row is stamped removed at the claim, so a recording_ready racing the vendor deletes is absorbed.
  const [live] = await db.recording.updateManyAndReturn({
    where: { ...eligible, id: recordingId, status: { not: "EXPIRED" } },
    data: { status: "EXPIRED", recordingUrl: "", removedAt: now },
    select: claimSelect,
  });
  const [rec] = live
    ? [live]
    : await db.recording.updateManyAndReturn({
        where: { ...eligible, id: recordingId, status: "EXPIRED" },
        data: { recordingUrl: "" },
        select: claimSelect,
      });
  if (!rec) return;

  const { deleteRecordingAssets } =
    await import("@/lib/stream/recording-storage");
  const streamCopyGone = await deleteStreamRecordingCopy(rec);
  const assets = await deleteRecordingAssets(
    { id: rec.id, storagePath: rec.storagePath },
    vendorFailures,
  );
  // Any vendor failure throws with the pointers still on the row for the retry.
  if (!assets.success) {
    throw new Error(
      assets.error ?? "Failed to delete recording object from storage",
    );
  }
  if (!streamCopyGone) {
    throw new Error("Stream copy of the recording was not confirmed deleted");
  }

  const cleared = await db.recording.updateMany({
    where: {
      id: rec.id,
      status: "EXPIRED",
      storagePath: rec.storagePath,
      previewClipStoragePath: rec.previewClipStoragePath,
      streamRecordingId: rec.streamRecordingId,
    },
    data: {
      storagePath: null,
      previewClipUrl: null,
      previewClipStoragePath: null,
      previewClipDuration: null,
      previewTranscript: null,
      thumbnailUrl: null,
      streamRecordingId: null,
      removedAt: rec.removedAt ?? now,
    },
  });
  if (cleared.count === 0) {
    const current = await db.recording.findUnique({
      where: { id: rec.id },
      select: {
        status: true,
        storagePath: true,
        previewClipStoragePath: true,
        streamRecordingId: true,
      },
    });
    if (
      current?.status === "EXPIRED" &&
      current.storagePath === null &&
      current.previewClipStoragePath === null &&
      current.streamRecordingId === null
    ) {
      return;
    }
    throw new Error("Recording asset pointers changed during erasure");
  }
}

async function unpublishHostedGroupRecordingsOnErasure(
  db: Db,
  userId: string,
  now: Date,
): Promise<void> {
  let listedSlugs: (string | null)[] = [];
  if (db.recording?.updateMany) {
    const where: Prisma.RecordingWhereInput = {
      listingStatus: "PUBLISHED",
      meeting: {
        occurrence: {
          appointment: {
            OR: [
              {
                webinar: {
                  webinarPlan: { consultantProfile: { userId } },
                },
              },
              {
                class: {
                  classPlan: { consultantProfile: { userId } },
                },
              },
            ],
          },
        },
      },
    };
    const listed =
      (await db.recording.findMany?.({
        where,
        select: { slug: true },
      })) ?? [];
    await db.recording.updateMany({
      where,
      data: {
        listingStatus: "UNPUBLISHED",
        unpublishedAt: now,
      },
    });
    if (Array.isArray(listed)) listedSlugs = listed.map((row) => row.slug);
  }

  if (db.recordingConsent?.updateMany) {
    await db.recordingConsent.updateMany({
      where: { userId, decision: "GRANTED" },
      data: { decision: "DECLINED", decidedAt: now },
    });
  }

  // After the scrub transaction has committed, and last so a purge failure cannot skip the steps above.
  if (listedSlugs.length > 0) purgeRecordingSurfaces(listedSlugs);
}

async function cleanupUserRecordingsOnErasure(
  db: Db,
  userId: string,
  now: Date,
): Promise<string[]> {
  const failures: string[] = [];
  const errors: unknown[] = [];
  // Storage-vendor failures report once per erasure run, not once per object.
  const vendorFailures = createRunFailureReporter("compliance");
  try {
    if (db.recording?.findMany) {
      const eligible: Prisma.RecordingWhereInput = {
        OR: [
          // FAILED rows are claimed too: a later recording_ready could promote one.
          { status: { not: "EXPIRED" } },
          {
            status: "EXPIRED",
            OR: [
              { storagePath: { not: null } },
              { previewClipStoragePath: { not: null } },
              { streamRecordingId: { not: null } },
            ],
          },
        ],
        purchases: { none: {} },
        meeting: {
          occurrence: {
            appointment: {
              appointmentType: {
                in: ["CONSULTATION", "SUBSCRIPTION", "TRIAL"],
              },
              OR: [
                { participants: { some: liveParticipant(userId) } },
                {
                  consultation: {
                    OR: [
                      { requestedBy: { userId } },
                      {
                        consultationPlan: {
                          consultantProfile: { userId },
                        },
                      },
                    ],
                  },
                },
                {
                  subscription: {
                    OR: [
                      { requestedBy: { userId } },
                      {
                        subscriptionPlan: {
                          consultantProfile: { userId },
                        },
                      },
                    ],
                  },
                },
                {
                  trial: {
                    OR: [
                      { consulteeProfile: { userId } },
                      { consultantProfile: { userId } },
                      {
                        subscriptionPlan: {
                          consultantProfile: { userId },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      };
      const oneToOneRecordings = await db.recording.findMany({
        where: eligible,
        select: { id: true },
      });

      if (Array.isArray(oneToOneRecordings)) {
        for (const rec of oneToOneRecordings) {
          try {
            await purgeSingleUserRecordingOnErasure(
              db,
              rec.id,
              eligible,
              now,
              vendorFailures,
            );
          } catch (error_) {
            failures.push(
              `recording_storage:${rec.id}: deletion not confirmed — re-run required`,
            );
            errors.push(error_);
          }
        }
      }
    }

    await unpublishHostedGroupRecordingsOnErasure(db, userId, now);
  } catch (error_) {
    failures.push(
      "recording_cleanup: could not complete recording erasure — re-run required",
    );
    errors.push(error_);
  }
  vendorFailures.flush();
  if (errors.length > 0) {
    reportSentryError(errors[0], {
      subsystem: "compliance",
      op: "scrubUser.cleanupUserRecordingsOnErasure",
      extra: {
        userId,
        failures: failures.slice(0, 20),
        causes: errors.slice(0, 20).map((e) => {
          const message = e instanceof Error ? e.message : String(e);
          return scrubStringValue(message).slice(0, 300);
        }),
        failed: errors.length,
      },
    });
  }
  return failures;
}

async function settleVendorErasureOutbox(
  prisma: Db,
  erasureRequestId: string | null,
  vendor: "STREAM" | "NOVU" | "RAZORPAY",
  vendorRef: string,
  error: string | null,
  now: Date,
): Promise<void> {
  if (!erasureRequestId || !prisma.vendorErasureRetry?.update) return;
  const whereKey = {
    erasureRequestId_vendor_vendorRef: {
      erasureRequestId,
      vendor,
      vendorRef,
    },
  };
  let nextAttempt = 1;
  if (error && prisma.vendorErasureRetry.findUnique) {
    const existing = await prisma.vendorErasureRetry
      .findUnique({ where: whereKey, select: { attempts: true } })
      .catch(() => null);
    nextAttempt = (existing?.attempts ?? 0) + 1;
  }
  await prisma.vendorErasureRetry
    .update({
      where: whereKey,
      data: error
        ? {
            status: "FAILED",
            attempts: { increment: 1 },
            lastError: error,
            nextRetryAt: nextRetryAt(nextAttempt, now),
          }
        : {
            status: "SUCCEEDED",
            attempts: { increment: 1 },
            completedAt: new Date(),
          },
    })
    .catch((error_) =>
      reportSentryError(error_, {
        subsystem: "compliance",
        op: "scrubUser.settleVendorErasureOutbox",
        extra: { erasureRequestId, vendor, vendorRef },
      }),
    );
}

async function retryErasedUserVendorCleanup(
  prisma: Db,
  userId: string,
): Promise<string[]> {
  const now = new Date();
  const vendorFailures = await offboardNotificationVendor(userId);
  const activeRequest = prisma.erasureRequest?.findFirst
    ? await prisma.erasureRequest.findFirst({
        where: { userId, status: { in: ["PENDING", "IN_PROGRESS"] } },
        orderBy: { requestedAt: "desc" },
        select: { id: true },
      })
    : null;
  if (activeRequest?.id) {
    await settleVendorErasureOutbox(
      prisma,
      activeRequest.id,
      "NOVU",
      userId,
      vendorFailures.length > 0 ? vendorFailures.join("; ") : null,
      now,
    );
    let streamError: string | null = null;
    try {
      await eraseStreamPrincipalFootprint(userId);
    } catch (error_) {
      streamError = error_ instanceof Error ? error_.message : String(error_);
      vendorFailures.push(
        "stream: principal deletion not confirmed — re-run required",
      );
    }
    await settleVendorErasureOutbox(
      prisma,
      activeRequest.id,
      "STREAM",
      userId,
      streamError,
      now,
    );
  }
  const recordingFailures = await cleanupUserRecordingsOnErasure(
    prisma,
    userId,
    now,
  );
  const documentFailures = await eraseUserSessionDocuments(prisma, userId, now);
  const supportFailures = await supportAttachmentPaths(prisma, userId).then(
    (paths) => removeSupportAttachmentObjects(paths, userId),
    (error_: unknown) => {
      reportSentryError(error_, {
        subsystem: "compliance",
        op: "scrubUser.supportAttachmentPaths",
        extra: { userId },
      });
      return ["support-attachments: storage cleanup failed; re-run erasure"];
    },
  );
  const productFileFailures = await purgeErasedCreatorFiles(
    prisma,
    userId,
    now,
  );
  vendorFailures.push(
    ...recordingFailures,
    ...documentFailures,
    ...supportFailures,
    ...productFileFailures,
  );
  return vendorFailures;
}

async function settlePrincipalStreamErasure(
  prisma: Db,
  userId: string,
  erasureRequestId: string | null,
  _principalOutboxQueued: boolean,
  now: Date,
): Promise<string[]> {
  if (!erasureRequestId) return [];

  const principalPlanId = principalStreamPlanId(userId);
  let principalError: string | null = null;
  try {
    await eraseStreamPrincipalFootprint(userId);
  } catch (error_) {
    principalError = error_ instanceof Error ? error_.message : String(error_);
  }
  if (principalError) {
    reportSentryError(new Error(`${principalError} on erasure`), {
      subsystem: "compliance",
      op: "scrubUser.eraseStreamPrincipalFootprint",
      extra: { userId },
    });
  }
  if (prisma.streamRevocationRetry?.update) {
    await prisma.streamRevocationRetry
      .update({
        where: {
          erasureRequestId_planType_planId: {
            erasureRequestId,
            planType: "WEBINAR",
            planId: principalPlanId,
          },
        },
        data: principalError
          ? {
              status: "FAILED",
              attempts: 1,
              lastError: principalError,
              nextRetryAt: nextRetryAt(1, now),
            }
          : { status: "SUCCEEDED", attempts: 1, completedAt: new Date() },
      })
      .catch((error_) =>
        reportSentryError(error_, {
          subsystem: "compliance",
          op: "scrubUser.settlePrincipalRevocationOutbox",
          extra: { userId },
        }),
      );
  }
  await settleVendorErasureOutbox(
    prisma,
    erasureRequestId,
    "STREAM",
    userId,
    principalError,
    now,
  );
  if (principalError) {
    return ["stream: principal deletion not confirmed — re-run required"];
  }
  return [];
}

export interface SoleOwnerOrganization {
  id: string;
  name: string;
  slug: string;
}

export async function soleOwnedOrganizations(
  db: Db,
  userId: string,
  options?: { includeInactive?: boolean },
): Promise<SoleOwnerOrganization[]> {
  const owned = await db.membership.findMany({
    where: {
      userId,
      role: "OWNER",
      status: "ACTIVE",
      organization: options?.includeInactive
        ? { deletedAt: null }
        : {
            deletedAt: null,
            status: { not: "DEACTIVATED" },
          },
    },
    select: {
      organizationId: true,
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  });
  if (owned.length === 0) return [];

  const otherOwnerGroups = await db.membership.groupBy({
    by: ["organizationId"],
    where: {
      organizationId: { in: owned.map((o) => o.organizationId) },
      role: "OWNER",
      status: "ACTIVE",
      userId: { not: userId },
    },
    _count: true,
  });
  const orgIdsWithCoOwner = new Set(
    otherOwnerGroups.map((g) => g.organizationId),
  );

  return owned
    .filter((row) => !orgIdsWithCoOwner.has(row.organizationId))
    .map((row) => ({
      id: row.organization.id,
      name: row.organization.name,
      slug: row.organization.slug,
    }));
}

export async function soleOwnerOrganizationsForUser(
  db: Db,
  userId: string,
): Promise<SoleOwnerOrganization[]> {
  return soleOwnedOrganizations(db, userId);
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
      email: true,
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
    // retry path for exactly that.
    const vendorFailures = await retryErasedUserVendorCleanup(prisma, userId);
    return {
      scrubbed: false,
      pseudonymousId: existing.pseudonymousId,
      affectedOrganizationIds: [],
      vendorFailures,
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
  const hasRazorpayWork =
    Boolean(existing.razorpayCustomerId) ||
    payoutAccounts.some((a) =>
      Boolean(a.razorpayContactId || a.razorpayFundAccId),
    );

  // The plans whose revocation the erasure request's outbox owns.
  let collaborationsRemoved: PlanRef[] = [];
  // The collaborator intents written when no request owns an outbox.
  let collaboratorIntents: { ref: PlanRef; generation: Date }[] = [];
  let owedCohostEmails: OwedCohostEmails[] = [];
  let archivedProducts: { consultantProfileId: string; slug: string }[] = [];
  let supportAttachmentPathsToRemove: string[] = [];
  let erasureRequestId: string | null = null;
  let principalOutboxQueued = false;
  let endedSessions: EndedSessions[] = [];
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
    supportAttachmentPathsToRemove = await scrubSupportPiiTx(tx, userId, now);
    archivedProducts = await scrubDigitalProductsTx(tx, userId, now);
    // Matched by the pre-erasure address, which the user update above replaces.
    await scrubMailFootprintTx(tx, { userId, email: existing.email });
    // Users are scrubbed, not deleted, so the cascade on these never fires.
    await tx.appointmentWaitlist.deleteMany({ where: { userId } });
    await tx.windowBackupInterest.deleteMany({ where: { userId } });
    // The referred user's apply-time IP hash and user agent; payer hashes stay for their two-year window.
    await tx.referral.updateMany({
      where: { referredUserId: userId },
      data: NULLED_REFERRAL_SIGNALS,
    });

    // The request being processed owns an outbox: every Stream revocation the
    // scrub owes is a durable row in this transaction, before the side effect
    // is attempted. The post-commit attempt completes the row and the retry
    // sweep drains whatever it could not.
    const request = await tx.erasureRequest.findFirst({
      where: { userId, status: { in: ["PENDING", "IN_PROGRESS"] } },
      orderBy: { requestedAt: "desc" },
      select: { id: true },
    });
    erasureRequestId = request?.id ?? null;
    const ownsRevocationOutbox = Boolean(
      erasureRequestId && tx.streamRevocationRetry?.createMany,
    );

    // An erased consultant leaves every team, as a banned one does. Their
    // access is recorded in the outbox when the scrub has one; otherwise each
    // ending writes the collaborator intent.
    const endedCollaborations = await endCollaborationsForUser(tx, userId, {
      endedByUserId: null,
      ownRevocationQueue: ownsRevocationOutbox,
    });
    owedCohostEmails = endedCollaborations.flatMap(
      (ended) => ended.notices.learnerEmails ?? [],
    );
    if (ownsRevocationOutbox) {
      collaborationsRemoved = endedCollaborations.map((ended) => ended.ref);
    } else {
      collaboratorIntents = endedCollaborations.flatMap((ended) =>
        ended.revocationGeneration
          ? [{ ref: ended.ref, generation: ended.revocationGeneration }]
          : [],
      );
    }

    if (erasureRequestId && ownsRevocationOutbox) {
      await tx.streamRevocationRetry.createMany({
        data: [
          ...collaborationsRemoved.map(({ planType, planId }) => ({
            erasureRequestId: erasureRequestId as string,
            planType: (planType === "webinar" ? "WEBINAR" : "CLASS") as
              "WEBINAR" | "CLASS",
            planId,
          })),
          {
            erasureRequestId: erasureRequestId as string,
            planType: "WEBINAR" as const,
            planId: principalStreamPlanId(userId),
          },
        ],
        skipDuplicates: true,
      });
      principalOutboxQueued = true;
    }

    if (erasureRequestId && tx.vendorErasureRetry?.upsert) {
      const vendorStages: Array<{
        vendor: "NOVU" | "STREAM" | "RAZORPAY";
        payload?: Record<string, unknown>;
      }> = [{ vendor: "NOVU" }, { vendor: "STREAM" }];
      if (hasRazorpayWork) {
        vendorStages.push({
          vendor: "RAZORPAY",
          payload: {
            customerId: existing.razorpayCustomerId ?? null,
            payoutAccounts: payoutAccounts.map((a) => ({
              id: a.id,
              razorpayContactId: a.razorpayContactId,
              razorpayFundAccId: a.razorpayFundAccId,
            })),
          },
        });
      }
      for (const stage of vendorStages) {
        const payloadField = stage.payload ? { payload: stage.payload } : {};
        await tx.vendorErasureRetry.upsert({
          where: {
            erasureRequestId_vendor_vendorRef: {
              erasureRequestId,
              vendor: stage.vendor,
              vendorRef: userId,
            },
          },
          create: {
            erasureRequestId,
            vendor: stage.vendor,
            vendorRef: userId,
            ...payloadField,
            status: "PENDING",
          },
          update: {
            ...payloadField,
            status: "PENDING",
          },
        });
      }
    }

    // Hard-delete sessions + accounts so SSO and password-based logins
    // both break immediately.
    endedSessions = (await revokeAllUserSessions(tx, userId)).ended;
    await detachSessionAccessLogs(tx, userId);
    await tx.account.deleteMany({ where: { userId } });

    // Withdraw all active DPDP ConsentArtifact rows while preserving their
    // monotonic 7-year audit retention window (DPDP §6(4)-(6) + §12) and
    // stamping subjectPseudonymousId on the user's consent artifacts.
    const subjectPseudonymousId = pseudonymousId;
    const consentRetainedUntil = new Date(now);
    consentRetainedUntil.setUTCFullYear(
      consentRetainedUntil.getUTCFullYear() + 7,
    );
    await tx.consentArtifact?.updateMany({
      where: {
        userId,
        withdrawnAt: null,
        auditRetainedUntil: { lt: consentRetainedUntil },
      },
      data: {
        withdrawnAt: now,
        auditRetainedUntil: consentRetainedUntil,
        subjectPseudonymousId,
      },
    });
    await tx.consentArtifact?.updateMany({
      where: { userId, withdrawnAt: null },
      data: {
        withdrawnAt: now,
        subjectPseudonymousId,
      },
    });
    await tx.consentArtifact?.updateMany({
      where: { userId, subjectPseudonymousId: null },
      data: { subjectPseudonymousId },
    });

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

      // Fan webhook events so integrators see the deprovisioning.
      // The data payload uses pseudonymousId — never the raw userId or
      // email — to keep with the erasure semantics.
      const orgMembership = memberships.find((m) => m.organizationId === orgId);
      await dispatchWebhookEvent({
        prisma: tx,
        organizationId: orgId,
        eventType: "member.removed",
        payload: {
          membershipId: orgMembership?.id,
          role: orgMembership?.role,
          previousStatus: orgMembership?.status,
          pseudonymousId,
          source: "dpdp_erasure",
          erasedAt: now.toISOString(),
        },
      });
    }
  });

  // After commit, so a failed access-log write never fails the erasure.
  await stampSessionEnds(endedSessions, { forgetUser: true });

  // Stream revocation is best-effort after commit, as in the moderation
  // side-effects; the rows are REMOVED either way. #1593 — each attempt
  // settles its outbox row: SUCCEEDED here, or FAILED with the first retry
  // slot for the sweep to pick up.
  for (const { planType, planId } of collaborationsRemoved) {
    let error: string | null = null;
    try {
      // Lazy: the scrub needs Stream only when a collaboration was flipped.
      // The erasure's own outbox row owns the retry, so the drive is unbudgeted.
      const { driveCollaboratorRevocation } =
        await import("@/lib/stream/collaborator-access");
      error = await driveCollaboratorRevocation(
        { planType, planId },
        userId,
        Number.POSITIVE_INFINITY,
      );
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
    if (!erasureRequestId || !prisma.streamRevocationRetry?.update) continue;
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

  // Without an outbox of its own the scrub drives each collaborator intent
  // once; an attempt that fails leaves the intent owed to the retry sweep.
  if (collaboratorIntents.length > 0) {
    try {
      const { revokeCollaboratorAccess } =
        await import("@/lib/stream/access-revocation");
      for (const { ref, generation } of collaboratorIntents) {
        await revokeCollaboratorAccess(ref, userId, generation);
      }
    } catch (caught) {
      reportSentryError(caught, {
        subsystem: "compliance",
        op: "scrubUser.revokeCollaboratorAccess",
      });
    }
  }

  // The seat holders' bell committed with the scrub; their email is its copy.
  if (owedCohostEmails.length > 0) {
    await sendOwedCohostEmails(owedCohostEmails, "scrubUser");
  }

  const principalFailures = await settlePrincipalStreamErasure(
    prisma,
    userId,
    erasureRequestId,
    principalOutboxQueued,
    now,
  );
  const recordingFailures = await cleanupUserRecordingsOnErasure(
    prisma,
    userId,
    now,
  );

  const paymentFailures = await offboardPaymentVendors(prisma, {
    userId,
    razorpayCustomerId: existing.razorpayCustomerId,
    payoutAccounts,
  });
  if (hasRazorpayWork) {
    await settleVendorErasureOutbox(
      prisma,
      erasureRequestId,
      "RAZORPAY",
      userId,
      paymentFailures.length > 0 ? paymentFailures.join("; ") : null,
      now,
    );
  }

  const documentFailures = await eraseUserSessionDocuments(prisma, userId, now);
  const supportFailures = await removeSupportAttachmentObjects(
    supportAttachmentPathsToRemove,
    userId,
  );
  // After commit, whether or not the creator had replays: a cached listing would keep their products.
  for (const product of archivedProducts) purgeDigitalProductSurfaces(product);
  const productFileFailures = await purgeErasedCreatorFiles(
    prisma,
    userId,
    now,
  );

  const vendorFailures = [
    ...paymentFailures,
    ...principalFailures,
    ...recordingFailures,
    ...documentFailures,
    ...supportFailures,
    ...productFileFailures,
  ];

  const notificationFailures = await offboardNotificationVendor(userId);
  await settleVendorErasureOutbox(
    prisma,
    erasureRequestId,
    "NOVU",
    userId,
    notificationFailures.length > 0 ? notificationFailures.join("; ") : null,
    now,
  );
  vendorFailures.push(...notificationFailures);

  // Last, so a purge failure cannot skip the steps above: cached testimonials carry the reviewer's and expert's names.
  const reviewCount =
    (await prisma.consultantReview?.count?.({
      where: {
        OR: [
          { consulteeProfile: { userId } },
          { consultantProfile: { userId } },
        ],
      },
    })) ?? 0;
  if (reviewCount > 0) purgeReviewSurfaces();

  return {
    scrubbed: true,
    pseudonymousId,
    affectedOrganizationIds,
    vendorFailures,
  };
}

/**
 * #1771 rows 1 and 5 — after commit, like the Stream revocations: delete the
 * buyer's saved-card tokens, then deactivate every RazorpayX fund account and
 * contact. A failure never aborts the scrub; it becomes a system event and a
 * `vendorFailures` entry. The Customer column is cleared only once its tokens
 * are gone and its PII is overwritten, so the reference survives for a retry.
 */
export async function offboardPaymentVendors(
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
