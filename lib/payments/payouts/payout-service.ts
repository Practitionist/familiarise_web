/**
 * Payout Service
 * Provider-agnostic payout orchestration with admin approval workflow
 */

import prisma from "@/lib/prisma";
import {
  PayoutStatus,
  PayoutMethod,
  PaymentGateway,
  EarningStatus,
} from "@prisma/client";
import { PAYOUT_CONSTANTS } from "./constants";
import {
  getRazorpayPayoutsService,
  isRazorpayPayoutsConfigured,
} from "./razorpay-payouts";
import {
  getStripeConnectService,
  isStripeConnectConfigured,
} from "./stripe-connect";
import { postLedgerTxn, type Posting } from "@/lib/payments/ledger/post";
import { computeMsmePaymentDeadline } from "@/lib/compliance/msme";
import { randomUUID } from "crypto";
import { acquireLock, releaseLock } from "@/lib/redis";
import {
  getCurrentFYCumulativePayments,
  getFYDateRange,
  getIndianFinancialYear,
  recordTDSDeduction,
  TDS_THRESHOLD_PAISE,
} from "@/lib/payments/tax/tds-service";
import { computeTdsForPayout } from "@/lib/compliance/tds";
import { notifyPayoutProcessed } from "@/lib/novu/service";
import { getAppUrl } from "@/lib/url";
import { sumPaise } from "@/lib/payments/utils/money";

// ============================================
// Types
// ============================================

export interface PayoutSummary {
  id: string;
  consultantProfileId: string;
  consultantName: string;
  consultantEmail: string | null;
  amount: number;
  currency: string;
  status: PayoutStatus;
  method: PayoutMethod;
  provider: PaymentGateway;
  earningsCount: number;
  createdAt: Date;
}

export interface PayoutResult {
  payoutId: string;
  success: boolean;
  providerPayoutId?: string;
  error?: string;
}

export interface BatchResult {
  batchId: string;
  total: number;
  successful: number;
  failed: number;
  results: PayoutResult[];
}

export interface ConsultantPayoutEligibility {
  consultantProfileId: string;
  isEligible: boolean;
  readyAmount: number;
  minimumAmount: number;
  hasPayoutAccount: boolean;
  defaultAccountId?: string;
  provider?: PaymentGateway;
}

// ============================================
// Payout Service
// ============================================

/**
 * Get all pending payouts awaiting admin approval
 */
export async function getPendingPayouts(): Promise<PayoutSummary[]> {
  const payouts = await prisma.consultantPayout.findMany({
    where: { status: PayoutStatus.PENDING },
    include: {
      consultantProfile: {
        include: {
          user: { select: { name: true, email: true } },
        },
      },
      earnings: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return payouts.map((p) => ({
    id: p.id,
    consultantProfileId: p.consultantProfileId,
    consultantName: p.consultantProfile.user.name || "Unknown",
    consultantEmail: p.consultantProfile.user.email,
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    method: p.method,
    provider: p.provider,
    earningsCount: p.earnings.length,
    createdAt: p.createdAt,
  }));
}

/**
 * Get payout details by ID
 */
export async function getPayoutById(payoutId: string) {
  return prisma.consultantPayout.findUnique({
    where: { id: payoutId },
    include: {
      consultantProfile: {
        include: {
          user: { select: { name: true, email: true } },
          payoutAccounts: true,
        },
      },
      earnings: {
        include: {
          payment: { select: { id: true, amount: true, createdAt: true } },
        },
      },
    },
  });
}

/**
 * Check consultant's payout eligibility
 */
export async function checkPayoutEligibility(
  consultantProfileId: string,
): Promise<ConsultantPayoutEligibility> {
  // FIX #617: Subtract refundedShareAmount from payout eligibility.
  // Use aggregate _sum of both fields (efficient DB-side) then subtract in JS.
  // refundedShareAmount is capped at consultantSharePaise by refundEarnings(), so the
  // difference is always >= 0.
  const readyEarningsAgg = await prisma.consultantEarnings.aggregate({
    where: {
      consultantProfileId,
      status: EarningStatus.READY,
      payoutId: null,
    },
    _sum: { consultantSharePaise: true, refundedShareAmount: true },
  });

  const readyAmount =
    sumPaise(readyEarningsAgg._sum.consultantSharePaise) -
    sumPaise(readyEarningsAgg._sum.refundedShareAmount);

  // Get default payout account
  const defaultAccount = await prisma.payoutAccount.findFirst({
    where: {
      consultantProfileId,
      isDefault: true,
      isVerified: true,
    },
  });

  return {
    consultantProfileId,
    isEligible:
      readyAmount >= PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT && !!defaultAccount,
    readyAmount,
    minimumAmount: PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT,
    hasPayoutAccount: !!defaultAccount,
    defaultAccountId: defaultAccount?.id,
    provider: defaultAccount?.provider,
  };
}

/**
 * Create a payout batch for approval
 * Called weekly (every Monday)
 *
 * NEW-2: Uses a distributed lock to prevent concurrent batch creation.
 * Without this, two concurrent calls (e.g., admin click + cron job) could both
 * read the same READY earnings, create separate payouts for the same consultant,
 * and leave orphaned payout records with no linked earnings.
 */
const PAYOUT_BATCH_LOCK_KEY = "lock:payout_batch_creation";
const PAYOUT_BATCH_LOCK_TTL = 120_000; // 2 minutes — generous for large batches

export async function createPayoutBatch(
  consultantProfileIds?: string[],
): Promise<string> {
  const lockToken = await acquireLock(
    PAYOUT_BATCH_LOCK_KEY,
    PAYOUT_BATCH_LOCK_TTL,
  );
  if (!lockToken) {
    throw new Error(
      "Payout batch creation is already in progress. Please wait and try again.",
    );
  }

  try {
    const batchId = `batch_${Date.now()}_${randomUUID().slice(0, 8)}`;

    // Get eligible consultants with ready earnings >= minimum payout
    const eligibleConsultants = await prisma.consultantEarnings.groupBy({
      by: ["consultantProfileId"],
      where: {
        status: EarningStatus.READY,
        payoutId: null,
        ...(consultantProfileIds?.length
          ? { consultantProfileId: { in: consultantProfileIds } }
          : {}),
      },
      orderBy: { consultantProfileId: "asc" },
      _sum: { consultantSharePaise: true },
      having: {
        consultantSharePaise: {
          _sum: { gte: PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT },
        },
      },
    });

    // FIX #568: Create each payout inside a transaction so the amount
    // recorded always matches the earnings actually linked. The groupBy
    // above gives us candidates; the transaction re-queries the exact
    // earnings, sums them, creates the payout, and links — atomically.
    for (const consultant of eligibleConsultants) {
      const { consultantProfileId } = consultant;

      // Get consultant's default payout account
      const account = await prisma.payoutAccount.findFirst({
        where: {
          consultantProfileId,
          isDefault: true,
          isVerified: true,
        },
      });

      if (!account) {
        console.warn(
          `No verified payout account for consultant ${consultantProfileId}`,
        );
        continue;
      }

      // Determine payout method based on account type
      let method: PayoutMethod;
      switch (account.accountType) {
        case "UPI":
          method = PayoutMethod.UPI;
          break;
        case "STRIPE_CONNECT":
          method = PayoutMethod.STRIPE_TRANSFER;
          break;
        default:
          method = PayoutMethod.BANK_TRANSFER;
      }

      // MSME 43B(h): the consultant is the supplier on the SELF path, so the
      // settlement deadline derives from their own status/agreement (not a
      // buyer org's). #776 — mirrors org-payout-service.
      const msmeProfile = await prisma.consultantProfile.findUnique({
        where: { id: consultantProfileId },
        select: { msmeStatus: true, writtenAgreementWithFamiliarise: true },
      });

      await prisma.$transaction(async (tx) => {
        // Re-query exact READY earnings inside the transaction
        const readyEarnings = await tx.consultantEarnings.findMany({
          where: {
            consultantProfileId,
            status: EarningStatus.READY,
            payoutId: null,
          },
          select: {
            id: true,
            consultantSharePaise: true,
            refundedShareAmount: true,
          },
        });

        if (readyEarnings.length === 0) return;

        // FIX #617: Subtract refundedShareAmount so partially refunded earnings
        // are paid at the correct (reduced) amount, not the original full share.
        const amount = readyEarnings.reduce(
          (sum, e) =>
            sum + Math.max(e.consultantSharePaise - e.refundedShareAmount, 0),
          0,
        );

        if (amount < PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT) return;

        const shouldAutoApprove =
          amount < PAYOUT_CONSTANTS.AUTO_APPROVE_THRESHOLD;

        // Create payout with the exact amount
        const payout = await tx.consultantPayout.create({
          data: {
            consultantProfileId,
            provider: account.provider,
            amount,
            currency: "INR",
            status: shouldAutoApprove
              ? PayoutStatus.APPROVED
              : PayoutStatus.PENDING,
            method,
            batchId,
            idempotencyKey: `payout_${consultantProfileId}_${batchId}`,
            approvedAt: shouldAutoApprove ? new Date() : undefined,
            approvedBy: shouldAutoApprove ? "SYSTEM_AUTO_APPROVE" : undefined,
            mustPayByDate: computeMsmePaymentDeadline({
              invoiceDate: new Date(),
              counterpartyMsmeStatus: msmeProfile?.msmeStatus ?? "NONE",
              writtenAgreement:
                msmeProfile?.writtenAgreementWithFamiliarise ?? false,
            }),
          },
        });

        // Link the exact earnings we summed, with guards against concurrent state changes
        const linkResult = await tx.consultantEarnings.updateMany({
          where: {
            id: { in: readyEarnings.map((e) => e.id) },
            status: EarningStatus.READY,
            payoutId: null,
          },
          data: {
            payoutId: payout.id,
          },
        });

        // If not all targeted earnings were linked, some changed state concurrently
        if (linkResult.count !== readyEarnings.length) {
          throw new Error(
            `Payout linking race: expected ${readyEarnings.length} earnings, linked ${linkResult.count} for consultant ${consultantProfileId}. Rolling back.`,
          );
        }
      });
    }

    return batchId;
  } finally {
    await releaseLock(PAYOUT_BATCH_LOCK_KEY, lockToken);
  }
}

/**
 * Approve a payout (admin action)
 *
 * C3 FIX: Validates payout is in PENDING status before approving.
 * Without this, a COMPLETED/PROCESSING/FAILED payout could be re-approved,
 * potentially causing double payouts.
 */
export async function approvePayout(
  payoutId: string,
  adminUserId: string,
): Promise<void> {
  const payout = await prisma.consultantPayout.findUnique({
    where: { id: payoutId },
  });

  if (!payout) {
    throw new Error(`Payout ${payoutId} not found`);
  }

  if (payout.status !== PayoutStatus.PENDING) {
    throw new Error(
      `Payout ${payoutId} cannot be approved (current status: ${payout.status}). Only PENDING payouts can be approved.`,
    );
  }

  await prisma.consultantPayout.update({
    where: { id: payoutId },
    data: {
      status: PayoutStatus.APPROVED,
      approvedAt: new Date(),
      approvedBy: adminUserId,
    },
  });
}

/**
 * Reject a payout (admin action)
 *
 * M4 FIX: Validates payout is in PENDING status before rejecting.
 * Without this, a PROCESSING or COMPLETED payout could be rejected,
 * unlinking earnings that may already be paid out.
 */
export async function rejectPayout(
  payoutId: string,
  reason: string,
): Promise<void> {
  const payout = await prisma.consultantPayout.findUnique({
    where: { id: payoutId },
    include: { earnings: true },
  });

  if (!payout) {
    throw new Error("Payout not found");
  }

  if (payout.status !== PayoutStatus.PENDING) {
    throw new Error(
      `Payout ${payoutId} cannot be rejected (current status: ${payout.status}). Only PENDING payouts can be rejected.`,
    );
  }

  // Unlink earnings and set them back to READY
  await prisma.consultantEarnings.updateMany({
    where: { payoutId },
    data: {
      payoutId: null,
    },
  });

  // Cancel the payout
  await prisma.consultantPayout.update({
    where: { id: payoutId },
    data: {
      status: PayoutStatus.CANCELLED,
      failureReason: reason,
    },
  });
}

/**
 * Process all approved payouts
 *
 * C4 FIX: Uses a distributed lock to prevent concurrent processing.
 * Without this, two workers (or cron triggers) could fetch the same APPROVED
 * payouts and send duplicate payments to the gateway.
 * Additionally, each payout is atomically claimed (APPROVED → PROCESSING)
 * before gateway calls to prevent double-processing.
 */
const PAYOUT_PROCESS_LOCK_KEY = "lock:payout_processing";
const PAYOUT_PROCESS_LOCK_TTL = 300_000; // 5 minutes — generous for batch processing

export async function processApprovedPayouts(): Promise<PayoutResult[]> {
  const lockToken = await acquireLock(
    PAYOUT_PROCESS_LOCK_KEY,
    PAYOUT_PROCESS_LOCK_TTL,
  );
  if (!lockToken) {
    console.warn(
      "[Payouts] Payout processing is already in progress. Skipping.",
    );
    return [];
  }

  try {
    const approvedPayouts = await prisma.consultantPayout.findMany({
      where: {
        status: PayoutStatus.APPROVED,
        retryCount: { lt: PAYOUT_CONSTANTS.MAX_RETRY_ATTEMPTS },
      },
      include: {
        consultantProfile: {
          include: {
            payoutAccounts: {
              where: { isDefault: true, isVerified: true },
            },
            user: true,
          },
        },
      },
    });

    const results: PayoutResult[] = [];

    for (const payout of approvedPayouts) {
      const result = await processSinglePayout(payout);
      results.push(result);
    }

    return results;
  } finally {
    await releaseLock(PAYOUT_PROCESS_LOCK_KEY, lockToken);
  }
}

/**
 * Process a single payout
 */
async function processSinglePayout(payout: {
  id: string;
  consultantProfileId: string;
  provider: PaymentGateway;
  amount: number;
  currency: string;
  method: PayoutMethod;
  idempotencyKey: string | null;
  consultantProfile: {
    payoutAccounts: Array<{
      razorpayFundAccId: string | null;
      stripeAccountId: string | null;
      accountType: string;
      [key: string]: unknown;
    }>;
    user: { name: string | null; email: string | null; [key: string]: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}): Promise<PayoutResult> {
  // Declared outside the try so the catch can tell a gateway-accepted payout
  // (providerPayoutId set) from a pre-gateway failure (#785 task #24).
  let providerPayoutId: string | undefined;
  try {
    // Mark as processing
    await prisma.consultantPayout.update({
      where: { id: payout.id },
      data: { status: PayoutStatus.PROCESSING },
    });

    const account = payout.consultantProfile.payoutAccounts[0];
    if (!account) {
      throw new Error("No payout account found");
    }

    // Non-resident payout guard — Razorpay only pays to Indian bank accounts
    const consultantTaxInfo = await prisma.consultantTaxInfo.findUnique({
      where: { consultantProfileId: payout.consultantProfileId },
    });
    if (consultantTaxInfo && !consultantTaxInfo.isIndianResident) {
      throw new Error(
        "Payouts to non-resident consultants are not supported yet (Section 195 TDS not implemented). " +
          `Consultant: ${payout.consultantProfileId}. Please process this payout manually.`,
      );
    }

    // #776 — Section 194-O (e-commerce operator) for consultant payouts via the
    // single canonical engine (compliance/tds.ts), replacing the deprecated 194J
    // path (#778 §E). 194J at 10% over-withheld ~100× vs 194-O's 0.1%. Mirrors
    // org-payout-service: PAN-at-rest is encrypted (plaintext decrypt deferred to
    // Form 26Q filing), so we signal only PAN-on-file presence; a missing PAN takes
    // the 194-O 5% no-PAN rate. The non-resident guard above already rejects
    // Section-195 cases, so RESIDENT is safe here.
    const financialYear = getIndianFinancialYear();

    // #785 — restore the ₹50K FY cumulative threshold dropped when this path
    // moved 194J→194-O. No withholding until cumulative FY payouts cross
    // TDS_THRESHOLD_PAISE; the crossing payout is taxed only on the excess.
    // Without this, sub-threshold consultants who legally owe ₹0 are withheld
    // from the first rupee. The rate engine (computeTdsForPayout) then applies
    // the section/PAN/DTAA rate to the taxable portion.
    //
    // #778 §E — TDS_ENGINE flag (default LEGACY): LEGACY keeps the ₹50K gate
    // (the conservative pre-CA-sign-off behavior); 194O drops it and taxes
    // the full payout under pure Section 194-O semantics (per-FY entity
    // thresholds move to the TdsRate lookup when the CA confirms in writing).
    // One env flip at launch, no money-logic redeploy.
    const pure194O = process.env.TDS_ENGINE === "194O";
    const cumulativeBeforePayout = await getCurrentFYCumulativePayments(
      payout.consultantProfileId,
      financialYear,
    );
    const cumulativeAfterPayout = cumulativeBeforePayout + payout.amount;
    let taxablePaise = 0;
    if (pure194O) {
      taxablePaise = payout.amount;
    } else if (cumulativeAfterPayout > TDS_THRESHOLD_PAISE) {
      taxablePaise =
        cumulativeBeforePayout >= TDS_THRESHOLD_PAISE
          ? payout.amount // already over threshold — whole payout is taxable
          : cumulativeAfterPayout - TDS_THRESHOLD_PAISE; // crossing — excess only
    }

    const tds =
      taxablePaise > 0
        ? computeTdsForPayout({
            grossAmountPaise: taxablePaise,
            consultant: {
              // #785 — PAN at rest is encrypted; signal presence via panOnFile
              // (passing the ciphertext as panNumber fails isValidPan → wrong 5%).
              panNumber: null,
              panOnFile: !!consultantTaxInfo?.panEncrypted,
              residencyStatus: "RESIDENT",
              tdsSection: null,
              tdsRateBps: null,
              tdsLowerRateCert: null,
              providerCountry: null,
            },
          })
        : {
            tdsSection: "194O",
            tdsRate: 0,
            tdsAmountPaise: 0,
            dtaaRateApplied: null,
            fallbackApplied: false,
            reason: `below ₹50K FY threshold (cumulative=${cumulativeAfterPayout} paise) — no TDS`,
          };

    const payoutAmountAfterTDS = payout.amount - tds.tdsAmountPaise;

    if (tds.tdsAmountPaise > 0) {
      console.log(
        JSON.stringify({
          event: "tds_deduction",
          payoutId: payout.id,
          consultantProfileId: payout.consultantProfileId,
          grossAmount: payout.amount,
          taxableAmount: taxablePaise,
          cumulativeBeforePayout,
          cumulativeAfterPayout,
          tdsAmount: tds.tdsAmountPaise,
          tdsRate: tds.tdsRate,
          tdsSection: tds.tdsSection,
          netAmount: payoutAmountAfterTDS,
          financialYear,
          reason: tds.reason,
          timestamp: new Date().toISOString(),
        }),
      );
    }

    // Use the payout object but with reduced amount for gateway call
    const payoutForGateway = { ...payout, amount: payoutAmountAfterTDS };

    if (payout.provider === PaymentGateway.RAZORPAY) {
      providerPayoutId = await processRazorpayPayout(payoutForGateway, account);
    } else if (payout.provider === PaymentGateway.STRIPE) {
      providerPayoutId = await processStripePayout(payoutForGateway, account);
    } else {
      throw new Error(`Unsupported provider: ${payout.provider}`);
    }

    // Update payout with provider ID and TDS info
    await prisma.consultantPayout.update({
      where: { id: payout.id },
      data: {
        providerPayoutId,
        tdsDeducted: tds.tdsAmountPaise,
        netAmount: payoutAmountAfterTDS,
        // #781 §C — engine returns a decimal fraction (0.001 = 194-O);
        // stored as integer bps so two engines can't disagree on units.
        // Review fix: != null so a legitimate 0% (Sec 197 zero-rate cert)
        // persists as 0 bps instead of vanishing to null.
        tdsRateAppliedBps:
          tds.tdsRate != null ? Math.round(tds.tdsRate * 10_000) : null,
        tdsFinancialYear: financialYear,
        status: PayoutStatus.PROCESSING, // Will be updated via webhook
      },
    });

    return {
      payoutId: payout.id,
      success: true,
      providerPayoutId,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    // #785 — if the gateway ALREADY accepted (providerPayoutId set) but the
    // post-submit DB write (L585) threw, the money was SENT. FAILing + unlinking
    // earnings here would re-batch them under a fresh idempotencyKey the gateway
    // won't dedupe → DOUBLE disbursement. Quarantine PROCESSING with earnings
    // LINKED instead; the reconcile/stuck-payout job settles it against the
    // gateway. Mirrors the scripts/payouts/process-payouts.ts guard (task #24).
    if (providerPayoutId) {
      try {
        await prisma.consultantPayout.update({
          where: { id: payout.id },
          data: {
            providerPayoutId,
            status: PayoutStatus.PROCESSING,
            failureReason:
              `Gateway accepted (${providerPayoutId}); post-submit DB write failed, awaiting reconcile: ${errorMessage}`.slice(
                0,
                500,
              ),
          },
        });
      } catch (persistErr) {
        console.error(
          `[payout-service] CRITICAL: gateway accepted ${providerPayoutId} but DB persist failed twice for payout ${payout.id}; manual reconcile required`,
          persistErr,
        );
      }
      console.error(
        `⚠️ Payout ${payout.id}: gateway accepted ${providerPayoutId} but DB write failed — quarantined PROCESSING (NOT failed) to avoid double-pay`,
      );
      return {
        payoutId: payout.id,
        success: false,
        providerPayoutId,
        error: `gateway-accepted-db-write-failed: ${errorMessage}`,
      };
    }

    // Genuine pre-gateway failure (rejected / never submitted) — safe to FAIL.
    await prisma.consultantPayout.update({
      where: { id: payout.id },
      data: {
        status: PayoutStatus.FAILED,
        failureReason: errorMessage,
        retryCount: { increment: 1 },
        tdsDeducted: 0,
        netAmount: null,
        tdsRateAppliedBps: null,
        tdsFinancialYear: null,
      },
    });

    // C5 FIX: Unlink earnings from the failed payout so they can be
    // picked up by the next batch. Without this, earnings linked to a
    // payout that failed before the gateway call (e.g., "No payout account")
    // would remain orphaned since no webhook fires to unlink them.
    await prisma.consultantEarnings.updateMany({
      where: { payoutId: payout.id },
      data: { payoutId: null },
    });

    return {
      payoutId: payout.id,
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Process payout via RazorpayX
 */
async function processRazorpayPayout(
  payout: {
    id: string;
    amount: number;
    currency: string;
    method: PayoutMethod;
    idempotencyKey: string | null;
  },
  account: {
    razorpayFundAccId: string | null;
    accountType: string;
  },
): Promise<string> {
  if (!isRazorpayPayoutsConfigured()) {
    throw new Error("RazorpayX Payouts not configured");
  }

  // Guard: Razorpay only processes INR payouts
  if (payout.currency !== "INR") {
    throw new Error(
      `Razorpay payouts only support INR. Got: ${payout.currency}. ` +
        `International payouts require manual processing for MVP.`,
    );
  }

  if (!account.razorpayFundAccId) {
    throw new Error("Razorpay fund account not found");
  }

  const razorpayPayouts = getRazorpayPayoutsService();

  // Determine payout mode
  const mode = razorpayPayouts.determinePayoutMode(
    payout.amount,
    account.accountType === "UPI" ? "vpa" : "bank_account",
  );

  const result = await razorpayPayouts.createPayout({
    fundAccountId: account.razorpayFundAccId,
    amount: payout.amount,
    currency: payout.currency,
    mode,
    purpose: "payout",
    queueIfLowBalance: true,
    referenceId: payout.id,
    // #771 P1-6 — use the deterministic key helper (not Date.now(), which
    // defeats RazorpayX idempotency on retry when payout.idempotencyKey is null).
    idempotencyKey:
      payout.idempotencyKey ||
      razorpayPayouts.generateIdempotencyKey(payout.id),
    notes: {
      payoutId: payout.id,
      source: "familiarise_platform",
    },
  });

  return result.id;
}

/**
 * Process payout via Stripe Connect
 */
async function processStripePayout(
  payout: {
    id: string;
    amount: number;
    currency: string;
  },
  account: {
    stripeAccountId: string | null;
  },
): Promise<string> {
  if (!isStripeConnectConfigured()) {
    throw new Error("Stripe Connect not configured");
  }

  if (!account.stripeAccountId) {
    throw new Error("Stripe connected account not found");
  }

  const stripeConnect = getStripeConnectService();

  // Create a transfer from platform to connected account
  const transfer = await stripeConnect.createTransfer({
    amount: payout.amount,
    currency: payout.currency.toLowerCase(),
    destinationAccountId: account.stripeAccountId,
    description: `Payout ${payout.id}`,
    metadata: {
      payoutId: payout.id,
      source: "familiarise_platform",
    },
  });

  return transfer.id;
}

/**
 * Handle payout webhook from provider
 *
 * C6 FIX: Wrapped in a prisma.$transaction() to ensure atomicity.
 * Without this, the payout status, earnings status, and consultant stats
 * could get out of sync if any individual DB call fails mid-way.
 */
export async function handlePayoutWebhook(
  _provider: PaymentGateway,
  providerPayoutId: string,
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED",
  failureReason?: string,
): Promise<void> {
  const payout = await prisma.consultantPayout.findFirst({
    where: { providerPayoutId },
    include: { earnings: true },
  });

  if (!payout) {
    console.warn(`Payout not found for provider ID: ${providerPayoutId}`);
    return;
  }

  // Map external status to our enum
  let payoutStatus: PayoutStatus;
  switch (status) {
    case "COMPLETED":
      payoutStatus = PayoutStatus.COMPLETED;
      break;
    case "FAILED":
      payoutStatus = PayoutStatus.FAILED;
      break;
    case "CANCELLED":
      payoutStatus = PayoutStatus.CANCELLED;
      break;
    case "PROCESSING":
      payoutStatus = PayoutStatus.PROCESSING;
      break;
    default:
      payoutStatus = PayoutStatus.PENDING;
  }

  await prisma.$transaction(async (tx) => {
    // Atomic conditional update: only transition if payout is NOT already terminal.
    // Uses updateMany with status filter so concurrent duplicates cannot both succeed.
    const { count } = await tx.consultantPayout.updateMany({
      where: {
        id: payout.id,
        status: { notIn: [PayoutStatus.COMPLETED, PayoutStatus.CANCELLED] },
      },
      data: {
        status: payoutStatus,
        processedAt:
          payoutStatus === PayoutStatus.COMPLETED ? new Date() : undefined,
        failureReason: failureReason,
      },
    });

    if (count === 0) {
      console.log(
        `Payout ${payout.id} already in terminal state, skipping duplicate ${status} webhook`,
      );
      return;
    }

    // If completed, update earnings and consultant stats
    if (payoutStatus === PayoutStatus.COMPLETED) {
      const financialYear = payout.tdsFinancialYear || getIndianFinancialYear();
      const { start, end } = getFYDateRange(financialYear);
      const previousCompletedPayouts = await tx.consultantPayout.aggregate({
        where: {
          consultantProfileId: payout.consultantProfileId,
          status: PayoutStatus.COMPLETED,
          processedAt: { gte: start, lte: end },
          id: { not: payout.id },
        },
        _sum: { amount: true },
      });
      const cumulativeCreditedPayments =
        sumPaise(previousCompletedPayouts._sum.amount) + payout.amount;

      // Update earnings to PAID
      await tx.consultantEarnings.updateMany({
        where: { payoutId: payout.id },
        data: {
          status: EarningStatus.PAID,
          paidAt: new Date(),
        },
      });

      // #771 D1/D5 — double-entry (dual-write): clear what we owed the
      // consultant. payout.amount is the cash that left; tdsDeducted was
      // withheld and is owed to the government.
      //   Dr CONSULTANT_PAYABLE (gross)   Cr CASH (paid)   Cr TDS_PAYABLE (withheld)
      if (payout.amount > 0) {
        const tdsPaise = payout.tdsDeducted ?? 0;
        const payoutPostings: Posting[] = [
          {
            account: {
              kind: "CONSULTANT_PAYABLE",
              consultantProfileId: payout.consultantProfileId,
            },
            direction: "DEBIT",
            amountPaise: payout.amount + tdsPaise,
          },
          {
            account: { kind: "CASH" },
            direction: "CREDIT",
            amountPaise: payout.amount,
          },
        ];
        if (tdsPaise > 0) {
          payoutPostings.push({
            account: { kind: "TDS_PAYABLE" },
            direction: "CREDIT",
            amountPaise: tdsPaise,
          });
        }
        await postLedgerTxn(tx, {
          idempotencyKey: `payout:${payout.id}`,
          kind: "PAYOUT",
          payoutId: payout.id,
          postings: payoutPostings,
        });
      }

      if (payout.tdsDeducted > 0 && payout.tdsRateAppliedBps) {
        await tx.tDSRecord.deleteMany({
          where: { payoutId: payout.id },
        });

        await recordTDSDeduction({
          consultantProfileId: payout.consultantProfileId,
          financialYear,
          tdsDeducted: payout.tdsDeducted,
          tdsRateBps: payout.tdsRateAppliedBps,
          cumulativeAmountCredited: cumulativeCreditedPayments,
          payoutId: payout.id,
          // #776 — consultant payouts withhold under Section 194-O (ECO).
          tdsSection: "194O",
          db: tx,
        });
      }
    }

    // If failed or cancelled, unlink earnings and reverse TDS records
    if (
      payoutStatus === PayoutStatus.FAILED ||
      payoutStatus === PayoutStatus.CANCELLED
    ) {
      await tx.consultantEarnings.updateMany({
        where: { payoutId: payout.id },
        data: {
          payoutId: null,
        },
      });

      // Delete TDS records — payout never completed, so TDS was never actually withheld
      await tx.tDSRecord.deleteMany({
        where: { payoutId: payout.id },
      });

      // Reset TDS fields on the payout record
      await tx.consultantPayout.update({
        where: { id: payout.id },
        data: {
          tdsDeducted: 0,
          netAmount: null,
          tdsRateAppliedBps: null,
          tdsFinancialYear: null,
        },
      });
    }
  });

  // Fire-and-forget: notify consultant when payout completes
  if (payoutStatus === PayoutStatus.COMPLETED) {
    const profile = await prisma.consultantProfile.findUnique({
      where: { id: payout.consultantProfileId },
      select: { userId: true },
    });
    if (profile?.userId) {
      void notifyPayoutProcessed(profile.userId, {
        amount: Number(payout.amount),
        currency: payout.currency,
        payoutId: payout.id,
        dashboardUrl: `${getAppUrl()}/dashboard`,
      }).catch((error) =>
        console.error("[payouts] Failed to send payout notification:", error),
      );
    }
  }
}

/**
 * #813/#812 — consultant `payout.reversed` arriving AFTER the payout already
 * COMPLETED. Mirrors markOrgPayoutReversed: handlePayoutWebhook maps `reversed`
 * to FAILED and claims `status notIn [COMPLETED, CANCELLED]`, so a bounce on an
 * already-COMPLETED payout was a SILENT no-op — cash had left (Dr
 * CONSULTANT_PAYABLE / Cr CASH / Cr TDS_PAYABLE, key `payout:<id>`), earnings
 * stayed PAID, nothing reversed. This atomically claims COMPLETED → REVERSED,
 * posts the exact inverse journal, and re-opens the earnings to READY. No-ops via
 * the claim if the payout is not COMPLETED, so the caller can attempt it first and
 * still fall through to the FAILED path for a pre-settlement bounce.
 */
export async function markConsultantPayoutReversed(
  providerPayoutId: string,
  reason: string,
): Promise<{ wasNoOp: boolean }> {
  const result = await prisma.$transaction(async (tx) => {
    const payout = await tx.consultantPayout.findFirst({
      where: { providerPayoutId },
      select: {
        id: true,
        consultantProfileId: true,
        amount: true,
        tdsDeducted: true,
        currency: true,
      },
    });
    if (!payout) {
      console.warn(
        `[payouts] markConsultantPayoutReversed: payout not found for provider ID ${providerPayoutId}`,
      );
      return { wasNoOp: true, notify: null };
    }

    // Atomic claim: only a COMPLETED payout has cash to bring back.
    const claim = await tx.consultantPayout.updateMany({
      where: { id: payout.id, status: PayoutStatus.COMPLETED },
      data: {
        status: PayoutStatus.REVERSED,
        failureReason: reason.slice(0, 500),
      },
    });
    if (claim.count === 0) return { wasNoOp: true, notify: null };

    // Re-open the earnings this payout had marked PAID so a future batch re-pays
    // them — the inverse of the completion path's PAID flip. Unlike the FAILED
    // path we do NOT delete TDS records (mirrors the org reversal, which only
    // reverses the TDS_PAYABLE accrual in the journal below).
    await tx.consultantEarnings.updateMany({
      where: { payoutId: payout.id, status: EarningStatus.PAID },
      data: { status: EarningStatus.READY, payoutId: null, paidAt: null },
    });

    // Exact inverse of the completion posting `payout:<id>`:
    //   original  Dr CONSULTANT_PAYABLE (gross)  Cr CASH (net)  Cr TDS_PAYABLE (tds)
    //   reversal  Dr CASH (net)  Cr CONSULTANT_PAYABLE (gross)  Dr TDS_PAYABLE (tds)
    if (payout.amount > 0) {
      const tdsPaise = payout.tdsDeducted ?? 0;
      const reversal: Posting[] = [
        {
          account: { kind: "CASH" },
          direction: "DEBIT",
          amountPaise: payout.amount,
        },
        {
          account: {
            kind: "CONSULTANT_PAYABLE",
            consultantProfileId: payout.consultantProfileId,
          },
          direction: "CREDIT",
          amountPaise: payout.amount + tdsPaise,
        },
      ];
      if (tdsPaise > 0) {
        reversal.push({
          account: { kind: "TDS_PAYABLE" },
          direction: "DEBIT",
          amountPaise: tdsPaise,
        });
      }
      await postLedgerTxn(tx, {
        idempotencyKey: `payout-reversal:${payout.id}`,
        kind: "PAYOUT",
        payoutId: payout.id,
        postings: reversal,
      });
    }

    // No consultant-scoped audit table (OrgAuditLog is org-only) and no
    // consultant payout-reversal Novu workflow exists — the structured log is the
    // mirror of the org path's PAYOUT_REVERSED audit entry.
    console.log(
      `↩️  Consultant payout ${payout.id} reversed after completion (provider=${providerPayoutId}): ${reason.slice(0, 200)}`,
    );

    return { wasNoOp: false, notify: null };
  });

  return { wasNoOp: result.wasNoOp };
}

/**
 * Get payout statistics for dashboard
 */
export async function getPayoutStats() {
  const [pending, processing, completed, failed] = await Promise.all([
    prisma.consultantPayout.aggregate({
      where: { status: PayoutStatus.PENDING },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.consultantPayout.aggregate({
      where: { status: PayoutStatus.PROCESSING },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.consultantPayout.aggregate({
      where: { status: PayoutStatus.COMPLETED },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.consultantPayout.aggregate({
      where: { status: PayoutStatus.FAILED },
      _sum: { amount: true },
      _count: true,
    }),
  ]);

  return {
    pending: {
      count: pending._count,
      amount: sumPaise(pending._sum.amount),
    },
    processing: {
      count: processing._count,
      amount: sumPaise(processing._sum.amount),
    },
    completed: {
      count: completed._count,
      amount: sumPaise(completed._sum.amount),
    },
    failed: {
      count: failed._count,
      amount: sumPaise(failed._sum.amount),
    },
  };
}
