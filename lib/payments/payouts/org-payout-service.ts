/**
 * Organization Payout Service — full rewrite (#713-2 / #700 LED-4).
 *
 * Replaces the prior @arch4-stub. The service exposes three operations
 * that crons + the org-payouts route share so org-level batching has a
 * single source of truth:
 *
 *   - getOrgPayoutEligibility(orgId)
 *       Read-only check: does this org have a verified payout account
 *       and any READY OrganizationEarnings? Returns shape callers can
 *       safely render in a dashboard ("you have ₹X ready, Y rows").
 *
 *   - createOrgPayoutBatch(orgId, periodStart, periodEnd, opts?)
 *       Atomic batch creation: claim READY earnings, compute aggregated
 *       totals, write the OrganizationPayout (status DRAFT/PENDING),
 *       flip the claimed earnings to PAID, write SettlementLedgerEntry
 *       + audit log. Optionally accepts an `idempotencyKey` so cron
 *       retries become no-ops via the unique constraint.
 *
 *   - processOrgPayout(payoutId)
 *       State machine progression: PENDING → PROCESSING → COMPLETED |
 *       FAILED. Today only progresses PENDING → PROCESSING and writes
 *       the audit log + SettlementLedgerEntry; live RazorpayX /
 *       Stripe Connect submission is gated on `ENABLE_LIVE_PAYOUTS` and
 *       lands in PR-3.
 *
 *   - markOrgPayoutCompleted(payoutId)
 *       Idempotent PROCESSING → COMPLETED transition + Novu fire to the
 *       visibility roster. Called by the gateway-webhook reconciler
 *       (PR-3); kept here so the notification dispatch is co-located with
 *       the state change (closes #718 / BUG-017).
 *
 * Atomicity:
 *   - createOrgPayoutBatch acquires a Redis lock keyed by orgId so two
 *     concurrent callers (cron + UI button + manual replay) cannot both
 *     start a batch for the same org. Inside the lock the DB tx is
 *     Serializable for phantom-read safety.
 *   - The earnings claim step is a conditional UPDATE that only catches
 *     rows still NULL on `orgPayoutId` — even without the Redis lock
 *     this prevents double-claiming. The lock buys us deterministic
 *     ordering and a clean error path.
 *
 * India statutory compliance (TDS / MSME / Form15 / FIRC):
 *   - Stub helpers in lib/compliance/{tds,msme,form15} are called so
 *     downstream rows have non-null defaults. Live derivation lands in
 *     PR-2 (India compliance go-live). The cron at
 *     `jobs/compliance/derive-tds-msme.ts` (also part of PR-2) will
 *     re-derive these for any rows still on stub defaults.
 */

import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { PaymentGateway, PayoutStatus } from "@prisma/client";
import { acquireLock, releaseLock } from "@/lib/redis";
import { computeMsmePaymentDeadline } from "@/lib/compliance/msme";
import { computeTdsForPayout } from "@/lib/compliance/tds";
import { postLedgerTxn, type Posting } from "@/lib/payments/ledger/post";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { notifyOrgPayoutCompleted } from "@/lib/novu/org-workflows";
import { getAppUrl } from "@/lib/url";

export class PayoutLockError extends Error {
  readonly code = "PAYOUT_LOCK_CONFLICT" as const;
  constructor(message?: string) {
    super(
      message ??
        "Another payout batch is being created for this organization. Please try again.",
    );
    this.name = "PayoutLockError";
  }
}

export class PayoutValidationError extends Error {
  readonly code = "PAYOUT_VALIDATION_FAILED" as const;
  constructor(
    message: string,
    public httpStatus = 409,
  ) {
    super(message);
    this.name = "PayoutValidationError";
  }
}

export interface OrgPayoutEligibility {
  eligible: boolean;
  readyAmount: number;
  earningsCount: number;
  payoutAccountStatus: string | null;
  reason?: string;
}

export interface OrgPayoutBatchResult {
  payoutId: string;
  amountPaise: number;
  earningsCount: number;
  periodStart: Date;
  periodEnd: Date;
  alreadyExisted?: boolean;
}

export interface CreateOrgPayoutBatchOptions {
  /** Channel used to push the funds (RazorpayX is the v1 default). */
  paymentGateway?: PaymentGateway;
  /** Cron-safe duplicate guard. When set, a row with the same key
   *  short-circuits to an idempotent response instead of creating a dup. */
  idempotencyKey?: string;
  /** Free-form audit notes; surfaces on SettlementLedgerEntry. */
  notes?: string;
  /** Membership id to attribute on the audit log; null for cron runs. */
  actorMembershipId?: string | null;
}

const PAYOUT_LOCK_TTL_MS = 60_000;

/**
 * Read-only eligibility probe. Safe to call from a dashboard render path.
 * Does NOT mutate any state.
 */
export async function getOrgPayoutEligibility(
  orgId: string,
): Promise<OrgPayoutEligibility> {
  const account = await prisma.organizationPayoutAccount.findUnique({
    where: { organizationId: orgId },
    select: { status: true },
  });

  if (!account) {
    return {
      eligible: false,
      readyAmount: 0,
      earningsCount: 0,
      payoutAccountStatus: null,
      reason: "No payout account configured",
    };
  }

  if (account.status !== "VERIFIED") {
    return {
      eligible: false,
      readyAmount: 0,
      earningsCount: 0,
      payoutAccountStatus: account.status,
      reason: `Payout account is ${account.status} — must be VERIFIED to receive funds`,
    };
  }

  const ready = await prisma.organizationEarnings.aggregate({
    where: {
      organizationId: orgId,
      status: "READY",
      orgPayoutId: null,
    },
    _sum: { orgSharePaise: true, refundedAmountPaise: true },
    _count: true,
  });

  const orgShareSum = ready._sum.orgSharePaise ?? 0;
  const refundsSum = ready._sum.refundedAmountPaise ?? 0;
  const readyAmount = orgShareSum - refundsSum;

  if (ready._count === 0 || readyAmount <= 0) {
    return {
      eligible: false,
      readyAmount: Math.max(0, readyAmount),
      earningsCount: ready._count,
      payoutAccountStatus: account.status,
      reason:
        ready._count === 0
          ? "No READY earnings to batch"
          : `Net payout would be ${readyAmount} paise after refunds — reconcile first`,
    };
  }

  return {
    eligible: true,
    readyAmount,
    earningsCount: ready._count,
    payoutAccountStatus: account.status,
  };
}

/**
 * Atomic batch creation. Acquires a Redis lock + Serializable tx so two
 * concurrent callers cannot both start a batch for the same org.
 *
 * If `idempotencyKey` is provided and a row already exists with that
 * key, returns the existing payout's identity with `alreadyExisted: true`.
 * This is the cron-safe path: a retried weekly run is a no-op.
 */
export async function createOrgPayoutBatch(
  orgId: string,
  periodStart: Date,
  periodEnd: Date,
  opts: CreateOrgPayoutBatchOptions = {},
): Promise<OrgPayoutBatchResult> {
  if (periodEnd.getTime() <= periodStart.getTime()) {
    throw new PayoutValidationError(
      "periodEnd must be after periodStart",
      400,
    );
  }

  // Idempotency short-circuit: cheaper than acquiring the lock just to
  // bounce on the unique constraint.
  if (opts.idempotencyKey) {
    const existing = await prisma.organizationPayout.findUnique({
      where: { idempotencyKey: opts.idempotencyKey },
      select: {
        id: true,
        amountPaise: true,
        periodStart: true,
        periodEnd: true,
        earnings: { select: { id: true } },
      },
    });
    if (existing) {
      return {
        payoutId: existing.id,
        amountPaise: existing.amountPaise,
        earningsCount: existing.earnings.length,
        periodStart: existing.periodStart,
        periodEnd: existing.periodEnd,
        alreadyExisted: true,
      };
    }
  }

  const lockKey = `org:${orgId}:payout-batch`;
  const token = await acquireLock(lockKey, PAYOUT_LOCK_TTL_MS);
  if (!token) {
    throw new PayoutLockError();
  }

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const payoutAccount = await tx.organizationPayoutAccount.findUnique({
          where: { organizationId: orgId },
        });
        if (!payoutAccount) {
          throw new PayoutValidationError(
            "No payout account configured for this organization",
            409,
          );
        }
        if (payoutAccount.status !== "VERIFIED") {
          throw new PayoutValidationError(
            `Payout account is ${payoutAccount.status} — cannot create payouts until VERIFIED`,
            409,
          );
        }

        // Race-safe claim: create placeholder, then atomically claim
        // READY earnings into it. Same proven pattern as the
        // /api/organizations/[orgId]/payouts route.
        const created = await tx.organizationPayout.create({
          data: {
            organizationId: orgId,
            amountPaise: 0,
            currency: "INR",
            status: "PENDING",
            paymentGateway: opts.paymentGateway ?? "RAZORPAY",
            periodStart,
            periodEnd,
            grossRevenuePaise: 0,
            platformFeePaise: 0,
            refundsPaise: 0,
            netPayoutPaise: 0,
            idempotencyKey: opts.idempotencyKey ?? null,
            // mustPayByDate, tdsSectionApplied, tdsAmountPaise,
            // dtaaRateApplied are derived after we resolve the org's
            // MSME + PAN fields below and persisted via the second
            // update (alongside the post-TDS amount). Form 15 / FIRC
            // still populated manually until cross-border crons land.
          },
        });

        const claim = await tx.organizationEarnings.updateMany({
          where: {
            organizationId: orgId,
            status: "READY",
            orgPayoutId: null,
            createdAt: { gte: periodStart, lt: periodEnd },
          },
          data: { orgPayoutId: created.id },
        });
        if (claim.count === 0) {
          throw new PayoutValidationError(
            "No READY earnings in the requested window",
            409,
          );
        }

        const readyEarnings = await tx.organizationEarnings.findMany({
          where: { orgPayoutId: created.id },
          select: {
            id: true,
            grossAmountPaise: true,
            platformFeePaise: true,
            orgSharePaise: true,
            refundedAmountPaise: true,
            currency: true,
          },
        });
        const first = readyEarnings[0];
        if (!first) {
          throw new PayoutValidationError(
            "No READY earnings in the requested window",
            409,
          );
        }
        const mixedCurrency = readyEarnings.some(
          (e) => e.currency !== first.currency,
        );
        if (mixedCurrency) {
          throw new PayoutValidationError(
            "Cannot roll earnings in mixed currencies into a single payout. Split the window.",
            409,
          );
        }

        const totals = readyEarnings.reduce(
          (acc, e) => {
            acc.gross += e.grossAmountPaise;
            acc.platformFeePaise += e.platformFeePaise;
            acc.orgShare += e.orgSharePaise;
            acc.refunds += e.refundedAmountPaise;
            return acc;
          },
          { gross: 0, platformFeePaise: 0, orgShare: 0, refunds: 0 },
        );
        const netPayout = totals.orgShare - totals.refunds;
        if (netPayout <= 0) {
          throw new PayoutValidationError(
            `Net payout would be ${netPayout} paise — refunds exceed earnings. Reconcile first.`,
            409,
          );
        }

        // Resolve the org's India statutory metadata in one fetch and
        // use it for both TDS (PAN, residency) and the MSME payment
        // deadline (msmeStatus, writtenAgreement).
        //
        // TDS: the marketplace e-commerce-operator rate (the old §194-O,
        // now §393 of the Income-tax Act 2025 in force since 1-Apr-2026)
        // is the default for payouts to host orgs; the no-PAN higher-rate
        // fallback (old §206AA, now §397(2)) applies when PAN is missing
        // or malformed. Computed on `netPayout` (= orgShare − refunds),
        // then deducted from what we send through the gateway. The withheld
        // amount is deposited with the govt and reported quarterly on the
        // return that succeeds Form 26Q (separate cron — see
        // lib/compliance/tds.ts module docblock).
        //
        // MSME: when the host org is MICRO / SMALL we owe payment within
        // 15 / 45 days under MSMED Act §15 (the deduction-disallowance
        // teeth moved from Income-tax §43B(h) to §37(2)(g) under the 2025
        // Act); fall through to contract.paymentTermsDays for MEDIUM / NONE.
        //
        // All host orgs are assumed RESIDENT in v1. When the first
        // non-resident host org ships, extend Organization with
        // `residencyStatus` + `tdsSection` overrides and thread them in.
        const orgForCompliance = await tx.organization.findUnique({
          where: { id: orgId },
          select: {
            taxInfo: { select: { panEncrypted: true } },
            msmeInfo: { select: { msmeStatus: true, msmeWrittenAgreementOnFile: true } },
          },
        });
        const tds = computeTdsForPayout({
          grossAmountPaise: netPayout,
          consultant: {
            // #768 — PAN at rest is encrypted. TDS rate derivation only
            // needs to know whether a PAN is on file (treats null as
            // higher-rate). Plaintext decrypt is deferred to Form 26Q
            // filing (admin-only flow).
            // #785 — PAN at rest is encrypted; signal presence via panOnFile
            // (passing the ciphertext as panNumber fails isValidPan → wrong 5%).
            panNumber: null,
            panOnFile: !!orgForCompliance?.taxInfo?.panEncrypted,
            residencyStatus: "RESIDENT",
            tdsSection: null,
            tdsRate: null,
            tdsLowerRateCert: null,
            providerCountry: null,
          },
        });
        const amountAfterTds = netPayout - tds.tdsAmountPaise;
        const mustPayByDate = computeMsmePaymentDeadline({
          invoiceDate: new Date(),
          counterpartyMsmeStatus: orgForCompliance?.msmeInfo?.msmeStatus ?? "NONE",
          writtenAgreement:
            orgForCompliance?.msmeInfo?.msmeWrittenAgreementOnFile ?? false,
        });

        await tx.organizationPayout.update({
          where: { id: created.id },
          data: {
            amountPaise: amountAfterTds,
            currency: first.currency,
            grossRevenuePaise: totals.gross,
            platformFeePaise: totals.platformFeePaise,
            refundsPaise: totals.refunds,
            netPayoutPaise: netPayout,
            tdsSectionApplied: tds.tdsSection,
            tdsAmountPaise: tds.tdsAmountPaise,
            dtaaRateApplied:
              tds.dtaaRateApplied !== null
                ? new Prisma.Decimal(tds.dtaaRateApplied)
                : null,
            mustPayByDate,
          },
        });

        await tx.organizationEarnings.updateMany({
          where: { orgPayoutId: created.id, status: "READY" },
          data: { status: "PAID" },
        });

        await tx.orgAuditLog.create({
          data: {
            organizationId: orgId,
            actorMembershipId: opts.actorMembershipId ?? null,
            category: "PAYOUT",
            action: AUDIT_ACTIONS.PAYOUT.PAYOUT_INITIATED,
            description: `Payout batch created: ${readyEarnings.length} earnings, ${amountAfterTds} paise ${first.currency} (after ${tds.tdsAmountPaise} paise TDS ${tds.tdsSection})`,
            details: {
              payoutId: created.id,
              earningsCount: readyEarnings.length,
              netPayoutPaise: netPayout,
              amountAfterTdsPaise: amountAfterTds,
              grossPaise: totals.gross,
              platformFeePaise: totals.platformFeePaise,
              refundsPaise: totals.refunds,
              tdsSection: tds.tdsSection,
              tdsRate: tds.tdsRate,
              tdsAmountPaise: tds.tdsAmountPaise,
              tdsFallback: tds.fallbackApplied,
              tdsReason: tds.reason,
              idempotencyKey: opts.idempotencyKey ?? null,
            },
          },
        });

        return {
          payoutId: created.id,
          amountPaise: amountAfterTds,
          earningsCount: readyEarnings.length,
          periodStart,
          periodEnd,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 25_000,
      },
    );

    return result;
  } catch (err) {
    // P2002 on idempotencyKey — a sibling cron worker landed first while
    // we were holding the lock-but-not-the-tx. Read the winner and
    // return it as-if-existing.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002" &&
      opts.idempotencyKey
    ) {
      const existing = await prisma.organizationPayout.findUnique({
        where: { idempotencyKey: opts.idempotencyKey },
        select: {
          id: true,
          amountPaise: true,
          periodStart: true,
          periodEnd: true,
          earnings: { select: { id: true } },
        },
      });
      if (existing) {
        return {
          payoutId: existing.id,
          amountPaise: existing.amountPaise,
          earningsCount: existing.earnings.length,
          periodStart: existing.periodStart,
          periodEnd: existing.periodEnd,
          alreadyExisted: true,
        };
      }
    }
    throw err;
  } finally {
    await releaseLock(lockKey, token);
  }
}

/**
 * Move a payout through its state machine. Today only progresses
 * `PENDING → PROCESSING` and writes the audit trail; live gateway
 * submission lands in PR-3 behind the `ENABLE_LIVE_PAYOUTS` flag.
 *
 * Idempotent: if the payout is not in PENDING the function logs and
 * returns the current status without throwing.
 */
export async function processOrgPayout(
  payoutId: string,
): Promise<{ status: PayoutStatus; submittedToGateway: boolean }> {
  const liveEnabled = process.env.ENABLE_LIVE_PAYOUTS === "true";

  return prisma.$transaction(async (tx) => {
    // #785 — when live payouts are gated OFF there is no gateway submission and
    // no webhook to advance or roll back the row, so claiming PENDING→PROCESSING
    // here would zombie it in PROCESSING forever (handle-stuck-payouts only
    // queries ConsultantPayout). Leave it PENDING until the flag flips on; the
    // cron re-attempts then.
    if (!liveEnabled) {
      const current = await tx.organizationPayout.findUnique({
        where: { id: payoutId },
        select: { status: true },
      });
      if (!current) {
        throw new PayoutValidationError(`Payout ${payoutId} not found`, 404);
      }
      return {
        status: current.status,
        submittedToGateway: false,
        claimed: false,
      };
    }

    const claim = await tx.organizationPayout.updateMany({
      where: { id: payoutId, status: "PENDING" },
      data: { status: "PROCESSING" },
    });
    if (claim.count === 0) {
      const current = await tx.organizationPayout.findUnique({
        where: { id: payoutId },
        select: { status: true },
      });
      if (!current) {
        throw new PayoutValidationError(
          `Payout ${payoutId} not found`,
          404,
        );
      }
      console.log(
        `[OrgPayoutService] processOrgPayout no-op: payout ${payoutId} status=${current.status}`,
      );
      // claimed: false — we did NOT advance the row, so the post-tx
      // submission must NOT fire (preventing double-submit on cron retry
      // of an already-PROCESSING row).
      return {
        status: current.status,
        submittedToGateway: false,
        claimed: false,
      };
    }

    const payout = await tx.organizationPayout.findUniqueOrThrow({
      where: { id: payoutId },
      select: {
        id: true,
        organizationId: true,
        amountPaise: true,
        currency: true,
      },
    });

    await tx.orgAuditLog.create({
      data: {
        organizationId: payout.organizationId,
        actorMembershipId: null,
        category: "PAYOUT",
        action: AUDIT_ACTIONS.PAYOUT.PAYOUT_PROCESSED,
        description: `Payout ${payoutId} moved PENDING → PROCESSING`,
        details: {
          payoutId,
          amountPaise: payout.amountPaise,
          currency: payout.currency,
          liveSubmissionEnabled: liveEnabled,
        },
      },
    });

    // Live gateway submission gated on env flag. The actual RazorpayX
    // `payouts.create` call happens AFTER the tx commits — we don't want
    // the gateway side-effect inside a serializable tx (long network
    // call, possibility of double-submit on retry). Returning here marks
    // the row PROCESSING; the post-tx submission either persists the
    // gatewayPayoutId on success or rolls the row to FAILED on a 4xx.
    return {
      status: "PROCESSING" as const,
      submittedToGateway: false,
      claimed: true,
    };
  }).then(async (result) => {
    if (!liveEnabled || !result.claimed || result.status !== "PROCESSING") {
      // Either live disabled, or this caller didn't claim the row, or
      // the row is no longer PROCESSING — skip submission.
      return { status: result.status, submittedToGateway: result.submittedToGateway };
    }

    // Post-tx submission: actual RazorpayX call. Idempotency key is
    // deterministic (`payout_<id>`) so a cron retry of the same payout
    // never creates a second gateway transfer (mandatory since
    // 2025-03-15 per RazorpayX). 4xx → mark FAILED + release earnings.
    // 5xx / network error → throw so the cron retries with the same key.
    try {
      await submitOrgPayoutToGateway(payoutId);
      return { status: "PROCESSING" as const, submittedToGateway: true };
    } catch (err) {
      const cls = classifyGatewaySubmissionError(err);
      if (cls === "PERMANENT_4XX") {
        await markPayoutFailedFromSubmission(
          payoutId,
          err instanceof Error ? err.message : String(err),
        );
        // Set true because we DID submit to the gateway — the rejection
        // is recorded on the row. False would imply we early-returned
        // before any gateway call, which isn't the case.
        return { status: "FAILED" as PayoutStatus, submittedToGateway: true };
      }
      // Transient — leave row in PROCESSING and re-throw so the cron
      // retries with the same idempotency key.
      throw err;
    }
  });
}

/**
 * Submit a payout to the live gateway. Called only when
 * `ENABLE_LIVE_PAYOUTS=true` and only AFTER `processOrgPayout` has
 * advanced the row to PROCESSING. Persists `gatewayPayoutId` +
 * `gatewayResponseRaw` on success. UTR comes later from the webhook.
 *
 * Idempotency: passes `payout_<id>` as the X-Payout-Idempotency header
 * so a duplicate call (cron retry) never creates a second transfer.
 */
async function submitOrgPayoutToGateway(payoutId: string): Promise<void> {
  const payout = await prisma.organizationPayout.findUniqueOrThrow({
    where: { id: payoutId },
    select: {
      id: true,
      organizationId: true,
      amountPaise: true,
      currency: true,
      paymentGateway: true,
      payoutReference: true,
    },
  });

  if (payout.paymentGateway !== "RAZORPAY") {
    // Stripe Connect path is deferred to Phase 2; the row stays in
    // PROCESSING until that lands. Don't throw — let the cron retry
    // visibility surface it.
    console.warn(
      `[OrgPayoutService] payout ${payoutId} gateway=${payout.paymentGateway} not yet supported`,
    );
    return;
  }

  // Account lookup is a separate query (the row's own organizationId is
  // the unique key on OrganizationPayoutAccount). Keeps the service
  // callable in unit tests that mock the two as independent spies.
  const account = await prisma.organizationPayoutAccount.findUnique({
    where: { organizationId: payout.organizationId },
    select: {
      status: true,
      razorpayContactId: true,
      razorpayFundAccountId: true,
    },
  });
  const fundAccountId = account?.razorpayFundAccountId ?? null;
  if (!fundAccountId) {
    throw new PayoutValidationError(
      `Payout ${payoutId}: organization has no razorpayFundAccountId on its payout account`,
      400,
    );
  }

  const { getRazorpayPayoutsService } = await import("./razorpay-payouts");
  const sdk = getRazorpayPayoutsService();
  const idempotencyKey = sdk.generateIdempotencyKey(payoutId);
  const mode = sdk.determinePayoutMode(payout.amountPaise, "bank_account");

  const response = await sdk.createPayout({
    fundAccountId,
    amount: payout.amountPaise,
    currency: payout.currency,
    mode,
    purpose: "payout",
    referenceId: payoutId,
    narration: `Familiarise org payout ${payoutId}`,
    queueIfLowBalance: true,
    idempotencyKey,
  });

  await prisma.organizationPayout.update({
    where: { id: payoutId },
    data: {
      gatewayPayoutId: response.id,
      gatewayResponseRaw: response as unknown as Prisma.JsonObject,
    },
  });
}

/**
 * Classify a RazorpayX SDK error as permanent (4xx — bank/data
 * rejection, never retry) vs transient (5xx / network — let the cron
 * retry with the same idempotency key).
 *
 * The SDK wraps fetch and throws a generic Error without HTTP-status
 * detail, so we sniff the message. Default is TRANSIENT so we never
 * silently drop a legitimate retry.
 */
function classifyGatewaySubmissionError(
  err: unknown,
): "PERMANENT_4XX" | "TRANSIENT_OR_UNKNOWN" {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (
    msg.includes("400") ||
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("422") ||
    msg.includes("invalid") ||
    msg.includes("bad request")
  ) {
    return "PERMANENT_4XX";
  }
  return "TRANSIENT_OR_UNKNOWN";
}

/**
 * Roll a PROCESSING payout to FAILED after a 4xx submission rejection.
 * Releases the underlying earnings back to READY so the next batch
 * picks them up. Does NOT fire Novu — the operator-facing audit log
 * is enough; the consultant-facing notification only fires for
 * webhook-time failures (where real money was at risk).
 */
async function markPayoutFailedFromSubmission(
  payoutId: string,
  reason: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const claim = await tx.organizationPayout.updateMany({
      where: { id: payoutId, status: "PROCESSING" },
      data: {
        status: "FAILED",
        failureReason: reason.slice(0, 500),
        failedAt: new Date(),
      },
    });
    if (claim.count === 0) return;

    // Release earnings back to READY so they're eligible for the next batch.
    await tx.organizationEarnings.updateMany({
      where: { orgPayoutId: payoutId, status: "PAID" },
      data: { status: "READY", orgPayoutId: null },
    });

    await tx.orgAuditLog.create({
      data: {
        organizationId: (
          await tx.organizationPayout.findUniqueOrThrow({
            where: { id: payoutId },
            select: { organizationId: true },
          })
        ).organizationId,
        actorMembershipId: null,
        category: "PAYOUT",
        action: AUDIT_ACTIONS.PAYOUT.PAYOUT_FAILED,
        description: `Payout ${payoutId} submission rejected by gateway (4xx)`,
        details: { payoutId, reason: reason.slice(0, 500) },
      },
    });
  });
}

/**
 * Idempotent PROCESSING → COMPLETED transition for an OrganizationPayout.
 *
 * Called by the gateway-webhook reconciler that PR-3 wires up; the
 * notification fire is intentionally co-located with the state change so
 * future call sites cannot forget to dispatch (#718 / BUG-017 root cause).
 *
 * Idempotency: the conditional updateMany only progresses rows still in
 * PROCESSING. A duplicate webhook delivery returns `wasNoOp: true` and
 * the notification is NOT re-sent.
 *
 * Notification: fired AFTER the transaction commits so a rolled-back
 * transition cannot page the visibility roster. `notifyOrgPayoutCompleted`
 * is non-throwing per its own contract.
 */
export async function markOrgPayoutCompleted(payoutId: string): Promise<{
  wasNoOp: boolean;
  status: PayoutStatus;
}> {
  const result = await prisma.$transaction(async (tx) => {
    const claim = await tx.organizationPayout.updateMany({
      where: { id: payoutId, status: "PROCESSING" },
      data: { status: "COMPLETED", processedAt: new Date() },
    });
    if (claim.count === 0) {
      const current = await tx.organizationPayout.findUnique({
        where: { id: payoutId },
        select: { status: true },
      });
      if (!current) {
        throw new PayoutValidationError(
          `Payout ${payoutId} not found`,
          404,
        );
      }
      console.log(
        `[OrgPayoutService] markOrgPayoutCompleted no-op: payout ${payoutId} status=${current.status}`,
      );
      return { wasNoOp: true, status: current.status, notify: null };
    }

    const payout = await tx.organizationPayout.findUniqueOrThrow({
      where: { id: payoutId },
      select: {
        id: true,
        organizationId: true,
        netPayoutPaise: true,
        tdsAmountPaise: true,
        currency: true,
        organization: { select: { name: true } },
      },
    });

    await tx.orgAuditLog.create({
      data: {
        organizationId: payout.organizationId,
        actorMembershipId: null,
        category: "PAYOUT",
        action: AUDIT_ACTIONS.PAYOUT.PAYOUT_COMPLETED,
        description: `Payout ${payoutId} moved PROCESSING → COMPLETED`,
        details: {
          payoutId,
          netPayoutPaise: payout.netPayoutPaise,
          currency: payout.currency,
        },
      },
    });

    // #771 D1/D5 — double-entry (dual-write): settle the host org's payable.
    //   Dr ORG_PAYABLE (gross)   Cr CASH (paid)   Cr TDS_PAYABLE (withheld)
    const orgTds = payout.tdsAmountPaise ?? 0;
    if (payout.netPayoutPaise > 0) {
      const orgPostings: Posting[] = [
        {
          account: {
            kind: "ORG_PAYABLE",
            organizationId: payout.organizationId,
            currency: payout.currency,
          },
          direction: "DEBIT",
          amountPaise: payout.netPayoutPaise + orgTds,
        },
        {
          account: { kind: "CASH", currency: payout.currency },
          direction: "CREDIT",
          amountPaise: payout.netPayoutPaise,
        },
      ];
      if (orgTds > 0) {
        orgPostings.push({
          account: { kind: "TDS_PAYABLE", currency: payout.currency },
          direction: "CREDIT",
          amountPaise: orgTds,
        });
      }
      await postLedgerTxn(tx, {
        idempotencyKey: `orgpayout:${payoutId}`,
        kind: "ORG_PAYOUT",
        payoutId,
        postings: orgPostings,
      });
    }

    return {
      wasNoOp: false,
      status: "COMPLETED" as PayoutStatus,
      notify: {
        organizationId: payout.organizationId,
        orgName: payout.organization.name,
        netPayoutPaise: payout.netPayoutPaise,
        currency: payout.currency,
      },
    };
  });

  if (result.notify) {
    await notifyOrgPayoutCompleted(result.notify.organizationId, {
      orgName: result.notify.orgName,
      payoutId,
      amountPaise: result.notify.netPayoutPaise,
      currency: result.notify.currency,
      dashboardUrl: `${getAppUrl()}/dashboard/organization/${result.notify.organizationId}/payouts`,
    });
  }

  return { wasNoOp: result.wasNoOp, status: result.status };
}

/**
 * A1+A8: shared internal helper for the "payout failed at the gateway"
 * and "payout reversed by the bank" code paths. Both reach this — the
 * `kind` parameter only changes the audit description and the Novu
 * payload; the state-machine effect is identical (PROCESSING → FAILED,
 * release earnings to READY, fire Novu).
 */
async function markOrgPayoutFailedInternal(
  payoutId: string,
  reason: string,
  kind: "FAILED" | "REVERSED",
): Promise<{ wasNoOp: boolean; status: PayoutStatus }> {
  const result = await prisma.$transaction(async (tx) => {
    const claim = await tx.organizationPayout.updateMany({
      where: { id: payoutId, status: "PROCESSING" },
      data: {
        status: "FAILED",
        failureReason: reason.slice(0, 500),
        failedAt: new Date(),
      },
    });
    if (claim.count === 0) {
      const current = await tx.organizationPayout.findUnique({
        where: { id: payoutId },
        select: { status: true },
      });
      if (!current) {
        throw new PayoutValidationError(
          `Payout ${payoutId} not found`,
          404,
        );
      }
      console.log(
        `[OrgPayoutService] markOrgPayoutFailedInternal no-op: payout ${payoutId} status=${current.status}`,
      );
      return { wasNoOp: true, status: current.status, notify: null };
    }

    // Release the underlying earnings back to READY so the next batch
    // sees them. This is the inverse of the createOrgPayoutBatch claim.
    await tx.organizationEarnings.updateMany({
      where: { orgPayoutId: payoutId, status: "PAID" },
      data: { status: "READY", orgPayoutId: null },
    });

    const payout = await tx.organizationPayout.findUniqueOrThrow({
      where: { id: payoutId },
      select: {
        id: true,
        organizationId: true,
        netPayoutPaise: true,
        currency: true,
        organization: { select: { name: true } },
      },
    });

    await tx.orgAuditLog.create({
      data: {
        organizationId: payout.organizationId,
        actorMembershipId: null,
        category: "PAYOUT",
        action:
          kind === "REVERSED"
            ? AUDIT_ACTIONS.PAYOUT.PAYOUT_REVERSED
            : AUDIT_ACTIONS.PAYOUT.PAYOUT_FAILED,
        description:
          kind === "REVERSED"
            ? `Payout ${payoutId} reversed by gateway: ${reason.slice(0, 200)}`
            : `Payout ${payoutId} failed at gateway: ${reason.slice(0, 200)}`,
        details: { payoutId, kind, reason: reason.slice(0, 500) },
      },
    });

    return {
      wasNoOp: false,
      status: "FAILED" as PayoutStatus,
      notify: {
        organizationId: payout.organizationId,
        orgName: payout.organization.name,
        netPayoutPaise: payout.netPayoutPaise,
        currency: payout.currency,
      },
    };
  });

  if (result.notify) {
    const { notifyOrgPayoutFailed } = await import("@/lib/novu/org-workflows");
    await notifyOrgPayoutFailed(result.notify.organizationId, {
      orgName: result.notify.orgName,
      payoutId,
      amountPaise: result.notify.netPayoutPaise,
      currency: result.notify.currency,
      reason: reason.slice(0, 200),
      kind,
      dashboardUrl: `${getAppUrl()}/dashboard/organization/${result.notify.organizationId}/payouts`,
    });
  }

  return { wasNoOp: result.wasNoOp, status: result.status };
}

/**
 * A1+A8: webhook-time PROCESSING → FAILED transition. Called when the
 * gateway sends `payout.failed` or `payout.rejected`. Releases earnings
 * to READY and fires `org-payout-failed` Novu workflow.
 */
export async function markOrgPayoutFailed(
  payoutId: string,
  reason: string,
): Promise<{ wasNoOp: boolean; status: PayoutStatus }> {
  return markOrgPayoutFailedInternal(payoutId, reason, "FAILED");
}

/**
 * A1+A8: webhook-time PROCESSING → FAILED transition for `payout.reversed`.
 * Behaviorally identical to `markOrgPayoutFailed` in v1; the audit log
 * and Novu payload distinguish the two so future ops can chase them
 * differently (a reversal often means the consultant's bank rejected
 * the credit and the org's account holder name needs an update).
 */
export async function markOrgPayoutReversed(
  payoutId: string,
  reason: string,
): Promise<{ wasNoOp: boolean; status: PayoutStatus }> {
  return markOrgPayoutFailedInternal(payoutId, reason, "REVERSED");
}
