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
  /// #1771 row 5 — Razorpay/RazorpayX steps that failed; each is also a system event.
  vendorFailures: string[];
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

export const STREAM_PRINCIPAL_PLAN_ID_PREFIX = "principal:";

export function principalStreamPlanId(userId: string): string {
  return `${STREAM_PRINCIPAL_PLAN_ID_PREFIX}${userId}`;
}

export async function eraseStreamPrincipalFootprint(
  userId: string,
): Promise<void> {
  const { getStreamChatClient, isExpectedStreamError, isStreamConfigured } =
    await import("@/lib/stream-client");
  if (typeof isStreamConfigured === "function" && !isStreamConfigured()) return;
  if (
    process.env.NODE_ENV === "test" &&
    !(getStreamChatClient as unknown as { _isMockFunction?: boolean })
      ._isMockFunction
  ) {
    return;
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

async function cleanupUserRecordingsOnErasure(
  db: Db,
  userId: string,
  now: Date,
): Promise<void> {
  try {
    if (db.recording?.findMany) {
      const oneToOneRecordings = await db.recording.findMany({
        where: {
          status: { notIn: ["EXPIRED", "FAILED"] },
          meeting: {
            occurrence: {
              appointment: {
                appointmentType: {
                  in: ["CONSULTATION", "SUBSCRIPTION", "TRIAL"],
                },
                OR: [
                  { participants: { some: { userId } } },
                  {
                    consultation: {
                      OR: [
                        { requestedBy: { userId } },
                        { consultationPlan: { consultantProfile: { userId } } },
                      ],
                    },
                  },
                  {
                    subscription: {
                      OR: [
                        { requestedBy: { userId } },
                        { subscriptionPlan: { consultantProfile: { userId } } },
                      ],
                    },
                  },
                  {
                    trial: {
                      OR: [
                        { consulteeProfile: { userId } },
                        { consultantProfile: { userId } },
                        { subscriptionPlan: { consultantProfile: { userId } } },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
        select: {
          id: true,
          storagePath: true,
          previewClipStoragePath: true,
        },
      });

      if (oneToOneRecordings.length > 0) {
        const { deleteRecordingObject } =
          await import("@/lib/stream/recording-storage");
        for (const rec of oneToOneRecordings) {
          if (rec.storagePath) {
            await deleteRecordingObject(rec.storagePath);
          }
          if (rec.previewClipStoragePath) {
            try {
              const storageMod =
                (await import("@/lib/supabase-storage-core")) as {
                  supabaseAdmin?: {
                    storage: {
                      from: (b: string) => {
                        remove: (p: string[]) => Promise<unknown>;
                      };
                    };
                  } | null;
                  supabase?: {
                    storage: {
                      from: (b: string) => {
                        remove: (p: string[]) => Promise<unknown>;
                      };
                    };
                  };
                  default?: {
                    storage: {
                      from: (b: string) => {
                        remove: (p: string[]) => Promise<unknown>;
                      };
                    };
                  };
                };
              const storageClient =
                storageMod.default ??
                storageMod.supabaseAdmin ??
                storageMod.supabase;
              await storageClient?.storage
                .from("recordings-previews")
                .remove([rec.previewClipStoragePath]);
            } catch {
              // Best-effort preview clip deletion
            }
          }
          const expiredData = {
            status: "EXPIRED" as const,
            recordingUrl: "",
            storageUrl: null,
            storagePath: null,
            previewClipUrl: null,
            previewClipStoragePath: null,
          };
          if (db.recording.update) {
            await db.recording.update({
              where: { id: rec.id },
              data: expiredData,
            });
          } else if (db.recording.updateMany) {
            await db.recording.updateMany({
              where: { id: rec.id },
              data: expiredData,
            });
          }
        }
      }
    }

    if (db.recording?.updateMany) {
      await db.recording.updateMany({
        where: {
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
        },
        data: {
          listingStatus: "UNPUBLISHED",
          unpublishedAt: now,
        },
      });
    }

    if (db.recordingConsent?.updateMany) {
      await db.recordingConsent.updateMany({
        where: { userId, decision: "GRANTED" },
        data: { decision: "DECLINED", decidedAt: now },
      });
    }
  } catch (caught) {
    reportSentryError(caught, {
      subsystem: "compliance",
      op: "scrubUser.cleanupUserRecordingsOnErasure",
      extra: { userId },
    });
  }
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
    //
    // Payment vendors are NOT re-attempted: they are guarded by the cleared
    // `razorpayCustomerId`, so a second pass has nothing to act on. A durable
    // outbox is the correct answer for guaranteed vendor delivery across a
    // process death between commit and the vendor calls — see the note on
    // `StreamRevocationRetry`, which is the pattern to extend rather than
    // reinvent.
    const vendorFailures = await offboardNotificationVendor(userId);
    try {
      await eraseStreamPrincipalFootprint(userId);
    } catch {
      vendorFailures.push(
        "stream: principal deletion not confirmed — re-run required",
      );
    }
    await cleanupUserRecordingsOnErasure(prisma, userId, new Date());
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

  let collaborationsRemoved: CollaborationRef[] = [];
  let erasureRequestId: string | null = null;
  let principalOutboxQueued = false;
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
    if (erasureRequestId && tx.streamRevocationRetry?.createMany) {
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

  const principalPlanId = principalStreamPlanId(userId);
  let principalError: string | null = null;
  try {
    await eraseStreamPrincipalFootprint(userId);
  } catch (caught) {
    principalError = caught instanceof Error ? caught.message : String(caught);
  }
  if (principalError) {
    reportSentryError(new Error(`${principalError} on erasure`), {
      subsystem: "compliance",
      op: "scrubUser.eraseStreamPrincipalFootprint",
      extra: { userId },
    });
  }
  if (erasureRequestId && prisma.streamRevocationRetry?.update) {
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
      .catch((caught) =>
        reportSentryError(caught, {
          subsystem: "compliance",
          op: "scrubUser.settlePrincipalRevocationOutbox",
          extra: { userId },
        }),
      );
  }

  await cleanupUserRecordingsOnErasure(prisma, userId, now);

  const vendorFailures = await offboardPaymentVendors(prisma, {
    userId,
    razorpayCustomerId: existing.razorpayCustomerId,
    payoutAccounts,
  });

  if (principalError && !principalOutboxQueued) {
    vendorFailures.push(
      "stream: principal deletion not confirmed — re-run required",
    );
  }

  const notificationFailures = await offboardNotificationVendor(userId);
  vendorFailures.push(...notificationFailures);

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
