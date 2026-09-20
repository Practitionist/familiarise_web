/**
 * Reverse penny drop for a consultant's payout account (#1675 PR-Y2).
 *
 * The consultant pays ₹1 from their own UPI app to the intent RazorpayX
 * mints; RazorpayX refunds it and answers with the bank account behind that
 * UPI id. We then create the contact + fund account for that account and
 * persist a reference-only row: the fund-account id, the last four digits,
 * the IFSC and the holder's name (owner decision 2026-09-20, #1771). The full
 * account number crosses this function once, in memory, and is never stored.
 *
 * Completion is asynchronous. RazorpayX also emits
 * `fund_account.validation.completed`, but that hook reaches production only,
 * so the client polls `settleReversePennyDrop` by id instead — the same
 * answer either way, without a preview-only blind spot.
 */

import prisma from "@/lib/prisma";
import { acquireLock, releaseLock } from "@/lib/redis";
import { Refusal } from "@/lib/errors/refusal";
import { PaymentError } from "@/lib/payments/core/types";
import { PaymentGateway, PayoutAccountType } from "@prisma/client";
import { PAYOUT_ACCOUNT_SAFE_SELECT } from "@/lib/data/consultant-payout-setup";
import {
  getRazorpayPayoutsService,
  isRazorpayPayoutsConfigured,
  type FundAccountValidationSummary,
} from "./razorpay-payouts";

export interface ReversePennyDropStart {
  validationId: string;
  upiIntent: NonNullable<FundAccountValidationSummary["upiIntent"]>;
}

export type ReversePennyDropOutcome =
  | { status: "pending" }
  | { status: "failed"; reason: string }
  | {
      status: "verified";
      account: {
        id: string;
        accountHolderName: string | null;
        bankName: string | null;
        accountNumberLast4: string | null;
        ifscCode: string | null;
        isVerified: boolean;
        isDefault: boolean;
      };
    };

function requireRazorpayX() {
  if (!isRazorpayPayoutsConfigured()) {
    throw new Refusal({
      code: "RAZORPAYX_UNCONFIGURED",
      httpStatus: 503,
      userMessage:
        "Bank verification is not switched on for the platform yet; nothing was saved.",
    });
  }
  return getRazorpayPayoutsService();
}

/**
 * The feature is enabled per RazorpayX account on request and is absent in
 * test mode, so a gateway refusal here is a modelled outcome with a manual
 * path beside it, not a fault worth a 500.
 */
async function gatewayCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof PaymentError) {
      throw new Refusal({
        code: "RPD_UNAVAILABLE",
        httpStatus: 503,
        userMessage:
          "The ₹1 verification is not available right now; add your account manually below.",
        devMessage: `reverse penny drop refused by RazorpayX: ${error.code} — ${error.message}`,
      });
    }
    throw error;
  }
}

export async function startReversePennyDrop(
  consultantProfileId: string,
): Promise<ReversePennyDropStart> {
  const razorpayX = requireRazorpayX();
  const validation = await gatewayCall(() =>
    razorpayX.createReversePennyDrop({
      // The id is the ownership proof the poll step checks against.
      referenceId: consultantProfileId,
      notes: { purpose: "consultant_payout_account_rpd" },
    }),
  );
  if (!validation.upiIntent) {
    throw new Refusal({
      code: "RPD_NO_INTENT",
      httpStatus: 502,
      userMessage:
        "The bank could not start the ₹1 verification. Try again in a moment or add your account manually.",
    });
  }
  return { validationId: validation.id, upiIntent: validation.upiIntent };
}

/** Long enough for two RazorpayX calls and two writes; short enough to self-heal. */
const SETTLE_LOCK_TTL_MS = 30_000;

/**
 * One poll: pending until the ₹1 lands; on completion the account is created
 * at RazorpayX and persisted. Re-polling after completion finds the row by
 * its masked tail + IFSC and returns it instead of creating a second one, and
 * overlapping polls for one validation are serialised by a Redis lock — the
 * schema has no column for the validation id, so the lock is the claim.
 */
export async function settleReversePennyDrop(
  consultantProfileId: string,
  validationId: string,
): Promise<ReversePennyDropOutcome> {
  const razorpayX = requireRazorpayX();
  const validation = await gatewayCall(() =>
    razorpayX.fetchFundAccountValidation(validationId),
  );

  if (validation.referenceId !== consultantProfileId) {
    throw new Refusal({
      code: "RPD_NOT_YOURS",
      httpStatus: 404,
      userMessage: "That verification does not belong to this account.",
    });
  }
  if (validation.status === "created") return { status: "pending" };
  if (validation.accountStatus !== "valid" || !validation.bankAccount) {
    return {
      status: "failed",
      reason:
        validation.failureReason ??
        "The bank did not confirm the account behind that UPI id.",
    };
  }

  const lockKey = `rpd:settle:${validationId}`;
  const lockToken = await acquireLock(lockKey, SETTLE_LOCK_TTL_MS);
  // Another poll holds the claim; the next tick will find the persisted row.
  if (!lockToken) return { status: "pending" };
  try {
    return await persistVerifiedAccount(razorpayX, consultantProfileId, {
      ...validation,
      bankAccount: validation.bankAccount,
    });
  } finally {
    await releaseLock(lockKey, lockToken);
  }
}

async function persistVerifiedAccount(
  razorpayX: ReturnType<typeof getRazorpayPayoutsService>,
  consultantProfileId: string,
  validation: FundAccountValidationSummary & {
    bankAccount: NonNullable<FundAccountValidationSummary["bankAccount"]>;
  },
): Promise<ReversePennyDropOutcome> {
  const { accountNumber, ifsc, bankName } = validation.bankAccount;
  const accountNumberLast4 = accountNumber.slice(-4);

  const existing = await prisma.payoutAccount.findFirst({
    where: {
      consultantProfileId,
      provider: PaymentGateway.RAZORPAY,
      accountNumberLast4,
      ifscCode: ifsc,
      isVerified: true,
    },
    select: PAYOUT_ACCOUNT_SAFE_SELECT,
  });
  if (existing) return { status: "verified", account: existing };

  const profile = await prisma.consultantProfile.findUniqueOrThrow({
    where: { id: consultantProfileId },
    select: {
      user: { select: { name: true, email: true } },
      payoutAccounts: {
        select: { razorpayContactId: true },
        where: { razorpayContactId: { not: null } },
        take: 1,
      },
    },
  });
  const holderName =
    validation.registeredName ?? profile.user.name ?? "Consultant";

  const contactId =
    profile.payoutAccounts[0]?.razorpayContactId ??
    (
      await razorpayX.createContact({
        name: holderName,
        email: profile.user.email ?? "",
        type: "vendor",
        referenceId: consultantProfileId,
      })
    ).id;
  const fundAccount = await razorpayX.createFundAccount({
    contactId,
    accountType: "bank_account",
    bankAccount: { name: holderName, ifsc, accountNumber },
  });

  // A verified account takes the default slot unless a verified default
  // already holds it — otherwise a pending manual entry would keep payouts
  // blocked after the consultant had just proved a working account.
  const currentDefault = await prisma.payoutAccount.findFirst({
    where: { consultantProfileId, isDefault: true },
    select: { isVerified: true },
  });
  const becomesDefault = !currentDefault?.isVerified;
  const data = {
    consultantProfileId,
    provider: PaymentGateway.RAZORPAY,
    accountType: PayoutAccountType.BANK_ACCOUNT,
    accountHolderName: holderName,
    bankName: bankName ?? undefined,
    accountNumberLast4,
    ifscCode: ifsc,
    razorpayContactId: contactId,
    razorpayFundAccId: fundAccount.id,
    isVerified: true,
    isDefault: becomesDefault,
  };
  if (!becomesDefault) {
    const account = await prisma.payoutAccount.create({
      data,
      select: PAYOUT_ACCOUNT_SAFE_SELECT,
    });
    return { status: "verified", account };
  }
  // Two writes on the tx client only (PG_POOL_MAX=1): one default at a time.
  const account = await prisma.$transaction(async (tx) => {
    await tx.payoutAccount.updateMany({
      where: { consultantProfileId, isDefault: true },
      data: { isDefault: false },
    });
    return tx.payoutAccount.create({
      data,
      select: PAYOUT_ACCOUNT_SAFE_SELECT,
    });
  });
  return { status: "verified", account };
}
