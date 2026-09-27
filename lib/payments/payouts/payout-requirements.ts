/**
 * What a consultant still has to give us before money can reach them, as one
 * pure derivation (#1675 PR-Y2). The Earnings banner, the Get-paid page's step
 * list and the Home needs-you row all read THIS, so the three surfaces cannot
 * disagree about what is missing.
 *
 * The shape borrows Stripe Connect's vocabulary: `currentlyDue` is what stands
 * between the consultant and their next payout, `eventuallyDue` is what we will
 * need at some point but nothing waits on today. A GSTIN is only ever
 * eventually due — most consultants are below the registration threshold.
 *
 * Prisma-free on purpose: the inputs are structural so the client can import
 * the labels without dragging the database client into the bundle.
 */

export type RequirementCode =
  | "PAN"
  | "PAYOUT_ACCOUNT"
  | "ACCOUNT_VERIFICATION"
  | "GSTIN";

export interface Requirement {
  code: RequirementCode;
  label: string;
  href: string;
}

/** The first gate a payout fails, in the order `checkPayoutEligibility` tests them. */
export type PayoutEligibilityReason =
  | "LIVE_PAYOUTS_OFF"
  | "NON_INDIA"
  | "NO_ACCOUNT"
  | "UNVERIFIED"
  | "BELOW_MINIMUM";

export interface PayoutRequirementsInput {
  consultantProfileId: string;
  taxInfo: { panLast4: string | null; gstin: string | null } | null;
  defaultAccount: { isVerified: boolean } | null;
  /** ConsultantEarnings rows of any status — the signal that money exists. */
  earningsCount: number;
  isIndianResident: boolean;
  livePayoutsEnabled: boolean;
}

export interface PayoutRequirements {
  currentlyDue: Requirement[];
  eventuallyDue: Requirement[];
  /** True when the payout account itself stands in the way of a transfer. */
  blocked: boolean;
}

export function payoutSettingsHref(consultantProfileId: string): string {
  // #1527 — the hub section itself, not the old /settings/payouts 308 hop.
  return `/dashboard/consultant/${encodeURIComponent(consultantProfileId)}/settings/get-paid`;
}

const REQUIREMENT_LABEL: Record<RequirementCode, string> = {
  PAYOUT_ACCOUNT: "Add a bank account or UPI ID",
  ACCOUNT_VERIFICATION: "Verify your bank account",
  PAN: "Add your PAN",
  GSTIN: "Add your GSTIN if you are registered",
};

/** The page anchor each step scrolls to; the codes share a card per subject. */
const REQUIREMENT_ANCHOR: Record<RequirementCode, string> = {
  PAYOUT_ACCOUNT: "account",
  ACCOUNT_VERIFICATION: "account",
  PAN: "pan",
  GSTIN: "gstin",
};

function requirement(
  code: RequirementCode,
  consultantProfileId: string,
): Requirement {
  return {
    code,
    label: REQUIREMENT_LABEL[code],
    href: `${payoutSettingsHref(consultantProfileId)}#${REQUIREMENT_ANCHOR[code]}`,
  };
}

/**
 * The account comes first because it is the only thing that stops a transfer
 * outright; a missing PAN only over-withholds (Section 194-O's no-PAN rate),
 * so it is due now only once there are earnings to withhold from.
 */
export function payoutRequirements(
  input: PayoutRequirementsInput,
): PayoutRequirements {
  const {
    consultantProfileId,
    taxInfo,
    defaultAccount,
    earningsCount,
    isIndianResident,
  } = input;
  const hasEarnings = earningsCount >= 1;
  const missing: RequirementCode[] = [];

  if (!defaultAccount) missing.push("PAYOUT_ACCOUNT");
  else if (!defaultAccount.isVerified) missing.push("ACCOUNT_VERIFICATION");
  // Section 194-O reaches residents only; a non-resident's withholding is the
  // Section 195 path, which the payout job refuses to automate anyway.
  if (isIndianResident && !taxInfo?.panLast4) missing.push("PAN");

  const currentlyDue: Requirement[] = [];
  const eventuallyDue: Requirement[] = [];
  for (const code of missing) {
    (hasEarnings ? currentlyDue : eventuallyDue).push(
      requirement(code, consultantProfileId),
    );
  }
  if (isIndianResident && !taxInfo?.gstin) {
    eventuallyDue.push(requirement("GSTIN", consultantProfileId));
  }

  return {
    currentlyDue,
    eventuallyDue,
    blocked: missing.some(
      (code) => code === "PAYOUT_ACCOUNT" || code === "ACCOUNT_VERIFICATION",
    ),
  };
}

export interface PayoutEligibilityGateInput {
  livePayoutsEnabled: boolean;
  isIndianResident: boolean;
  defaultAccount: { isVerified: boolean } | null;
  readyAmount: number;
  minimumAmount: number;
}

/**
 * The first failing gate, or null when a payout can go out. The order is the
 * order the batch job would refuse in, so the consultant is told the thing that
 * actually stops the money rather than the first thing we happened to check.
 */
export function payoutEligibilityReason(
  input: PayoutEligibilityGateInput,
): PayoutEligibilityReason | null {
  if (!input.livePayoutsEnabled) return "LIVE_PAYOUTS_OFF";
  if (!input.isIndianResident) return "NON_INDIA";
  if (!input.defaultAccount) return "NO_ACCOUNT";
  if (!input.defaultAccount.isVerified) return "UNVERIFIED";
  if (input.readyAmount < input.minimumAmount) return "BELOW_MINIMUM";
  return null;
}
