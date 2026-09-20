/**
 * The Get-paid page's calls (#1675 PR-Y2). Every write goes to an existing
 * Route Handler through `useMutation`; refusals arrive as `ApiResponseError`
 * with the server's `{ error, code }` and are worded by `userMessageFrom`.
 */

import { requireJsonResponse } from "@/lib/fetch-helpers";
import type { ConsultantPayoutSetup } from "@/lib/data/consultant-payout-setup";
import type { ReversePennyDropOutcome } from "@/lib/payments/payouts/reverse-penny-drop";

export type PayoutSetup = ConsultantPayoutSetup;
export type PayoutAccountView = PayoutSetup["accounts"][number];

export const payoutSetupQueryKey = (consultantId: string) =>
  ["consultant-payout-setup", consultantId] as const;

const JSON_HEADERS = { "Content-Type": "application/json" };

export async function fetchPayoutSetup(): Promise<PayoutSetup> {
  const res = await fetch("/api/consultant/payout-setup", {
    cache: "no-store",
  });
  return (await requireJsonResponse(
    res,
    "Failed to load payout setup",
  )) as PayoutSetup;
}

export type CreatePayoutAccountInput =
  | {
      accountType: "BANK_ACCOUNT";
      accountHolderName: string;
      accountNumber: string;
      ifscCode: string;
      bankName?: string;
    }
  | { accountType: "UPI"; accountHolderName: string; upiId: string };

export async function createPayoutAccount(
  input: CreatePayoutAccountInput,
): Promise<{ account: PayoutAccountView }> {
  const res = await fetch("/api/consultant/payout-accounts", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ provider: "RAZORPAY", ...input }),
  });
  return (await requireJsonResponse(res, "Could not save the account")) as {
    account: PayoutAccountView;
  };
}

export interface ReverifyResult {
  accountStatus: "valid" | "invalid" | "unknown";
  verification: "created" | "completed" | "failed";
  registeredName: string | null;
  nameMatchScore: number | null;
  account: PayoutAccountView;
}

export async function reverifyPayoutAccount(
  accountId: string,
): Promise<ReverifyResult> {
  const res = await fetch(
    `/api/consultant/payout-accounts/${encodeURIComponent(accountId)}`,
    {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ action: "reverify" }),
    },
  );
  return (await requireJsonResponse(
    res,
    "Could not check the account",
  )) as ReverifyResult;
}

export async function makeDefaultPayoutAccount(
  accountId: string,
): Promise<void> {
  const res = await fetch(
    `/api/consultant/payout-accounts/${encodeURIComponent(accountId)}`,
    {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ isDefault: true }),
    },
  );
  await requireJsonResponse(res, "Could not switch the default account");
}

export interface ReversePennyDropStartView {
  validationId: string;
  upiIntent: {
    intentUrl: string | null;
    gpayUrl: string | null;
    phonepeUrl: string | null;
    paytmUrl: string | null;
    bhimUrl: string | null;
    encodedQrCode: string | null;
  };
}

export async function startReversePennyDrop(): Promise<ReversePennyDropStartView> {
  const res = await fetch(
    "/api/consultant/payout-accounts/reverse-penny-drop",
    {
      method: "POST",
    },
  );
  return (await requireJsonResponse(
    res,
    "Could not start the ₹1 verification",
  )) as ReversePennyDropStartView;
}

export async function pollReversePennyDrop(
  validationId: string,
): Promise<ReversePennyDropOutcome> {
  const res = await fetch(
    `/api/consultant/payout-accounts/reverse-penny-drop/${encodeURIComponent(validationId)}`,
    { cache: "no-store" },
  );
  return (await requireJsonResponse(
    res,
    "Could not check the ₹1 verification",
  )) as ReversePennyDropOutcome;
}

export interface TaxInfoInput {
  panNumber?: string;
  taxEntityType?: "INDIVIDUAL" | "HUF" | "PARTNERSHIP" | "LLP" | "COMPANY";
  gstin?: string;
  msmeStatus?: "NONE" | "MICRO" | "SMALL" | "MEDIUM";
  udyamNumber?: string | null;
  msmeWrittenAgreement?: boolean;
}

export async function saveTaxInfo(input: TaxInfoInput): Promise<void> {
  const res = await fetch("/api/consultant/tax-info", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  await requireJsonResponse(res, "Could not save your tax details");
}
