/**
 * The consultant "Get paid" read (#1675 PR-Y2): payout accounts, tax info and
 * the requirements derived from them. The RSC page seeds it and the
 * `/api/consultant/payout-setup` route answers the client refetch with the
 * same function, so the two can never drift.
 *
 * Reads run one after another on the global client, never inside a
 * transaction — the pool is one connection per instance.
 */

import prisma from "@/lib/prisma";
import { ENABLE_LIVE_PAYOUTS } from "@/lib/feature-flags";
import { isRazorpayPayoutsConfigured } from "@/lib/payments/payouts/razorpay-payouts";
import {
  payoutEligibilityReason,
  payoutRequirements,
  type PayoutEligibilityReason,
  type PayoutRequirements,
} from "@/lib/payments/payouts/payout-requirements";
import { PAYOUT_CONSTANTS } from "@/lib/payments/payouts/constants";
import { sumPaise } from "@/lib/payments/utils/money";
import { EarningStatus } from "@prisma/client";

/**
 * What the consultant may see of their own payout account: the masked tail,
 * the IFSC, the UPI id and the flags. Never the RazorpayX contact or fund
 * account ids — the gateway reference is ours, not theirs.
 */
export const PAYOUT_ACCOUNT_SAFE_SELECT = {
  id: true,
  provider: true,
  accountType: true,
  accountHolderName: true,
  bankName: true,
  accountNumberLast4: true,
  ifscCode: true,
  upiId: true,
  isVerified: true,
  isDefault: true,
  createdAt: true,
} as const;

/** Mirrors the shape `GET /api/consultant/tax-info` answers with. */
const TAX_INFO_SELECT = {
  panLast4: true,
  panVerified: true,
  gstin: true,
  gstinVerified: true,
  country: true,
  isIndianResident: true,
  taxEntityType: true,
} as const;

export type ConsultantPayoutSetup = Awaited<
  ReturnType<typeof readConsultantPayoutSetup>
>;

/** The three inputs `payoutRequirements` needs, read in sequence. */
async function readRequirementInputs(consultantProfileId: string) {
  const taxInfo = await prisma.consultantTaxInfo.findUnique({
    where: { consultantProfileId },
    select: TAX_INFO_SELECT,
  });
  const defaultAccount = await prisma.payoutAccount.findFirst({
    where: { consultantProfileId, isDefault: true },
    select: { isVerified: true },
  });
  const earningsCount = await prisma.consultantEarnings.count({
    where: { consultantProfileId },
  });
  return { taxInfo, defaultAccount, earningsCount };
}

/**
 * The eligibility gate without the READY aggregate: the account reasons sit
 * ahead of BELOW_MINIMUM, so a caller that only asks "is the account what
 * stops the money?" (the Home row) needs no balance. `readyAmount` is pinned
 * at the minimum so the answer is never BELOW_MINIMUM by accident.
 */
export async function readPayoutGate(
  consultantProfileId: string,
): Promise<{ reason: PayoutEligibilityReason | null }> {
  const taxInfo = await prisma.consultantTaxInfo.findUnique({
    where: { consultantProfileId },
    select: { isIndianResident: true },
  });
  const defaultAccount = await prisma.payoutAccount.findFirst({
    where: { consultantProfileId, isDefault: true },
    select: { isVerified: true },
  });
  return {
    reason: payoutEligibilityReason({
      livePayoutsEnabled: ENABLE_LIVE_PAYOUTS,
      isIndianResident: taxInfo?.isIndianResident ?? true,
      defaultAccount,
      readyAmount: PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT,
      minimumAmount: PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT,
    }),
  };
}

export async function readPayoutRequirements(
  consultantProfileId: string,
): Promise<PayoutRequirements> {
  const inputs = await readRequirementInputs(consultantProfileId);
  return payoutRequirements({
    consultantProfileId,
    ...inputs,
    isIndianResident: inputs.taxInfo?.isIndianResident ?? true,
    livePayoutsEnabled: ENABLE_LIVE_PAYOUTS,
  });
}

export async function readConsultantPayoutSetup(consultantProfileId: string) {
  const inputs = await readRequirementInputs(consultantProfileId);
  const profile = await prisma.consultantProfile.findUnique({
    where: { id: consultantProfileId },
    select: {
      msmeStatus: true,
      udyamNumber: true,
      writtenAgreementWithFamiliarise: true,
      payoutAccounts: {
        select: PAYOUT_ACCOUNT_SAFE_SELECT,
        orderBy: { createdAt: "desc" },
      },
    },
  });
  const readyAgg = await prisma.consultantEarnings.aggregate({
    where: {
      consultantProfileId,
      status: EarningStatus.READY,
      payoutId: null,
    },
    _sum: { consultantSharePaise: true, refundedShareAmount: true },
  });

  const { taxInfo, defaultAccount, earningsCount } = inputs;
  const isIndianResident = taxInfo?.isIndianResident ?? true;
  const readyAmount =
    sumPaise(readyAgg._sum.consultantSharePaise) -
    sumPaise(readyAgg._sum.refundedShareAmount);
  const eligibilityReason: PayoutEligibilityReason | null =
    payoutEligibilityReason({
      livePayoutsEnabled: ENABLE_LIVE_PAYOUTS,
      isIndianResident,
      defaultAccount,
      readyAmount,
      minimumAmount: PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT,
    });

  return {
    accounts: profile?.payoutAccounts ?? [],
    taxInfo: {
      hasTaxInfo: taxInfo !== null,
      panMasked: taxInfo?.panLast4 ? `XXXXXX${taxInfo.panLast4}` : null,
      panVerified: taxInfo?.panVerified ?? false,
      gstin: taxInfo?.gstin ?? null,
      gstinVerified: taxInfo?.gstinVerified ?? false,
      country: taxInfo?.country ?? "IN",
      isIndianResident,
      taxEntityType: taxInfo?.taxEntityType ?? null,
      msmeStatus: profile?.msmeStatus ?? "NONE",
      udyamNumber: profile?.udyamNumber ?? null,
      msmeWrittenAgreement: profile?.writtenAgreementWithFamiliarise ?? false,
    },
    requirements: payoutRequirements({
      consultantProfileId,
      taxInfo,
      defaultAccount,
      earningsCount,
      isIndianResident,
      livePayoutsEnabled: ENABLE_LIVE_PAYOUTS,
    }),
    eligibilityReason,
    readyAmount,
    minimumAmount: PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT,
    livePayoutsEnabled: ENABLE_LIVE_PAYOUTS,
    razorpayConfigured: isRazorpayPayoutsConfigured(),
  };
}
