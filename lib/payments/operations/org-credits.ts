/**
 * @deprecated since Arch 4-Modified (Issue #681).
 *
 * SEAT_PACK / OrgCreditPool was replaced by `BillingAccount.fundingSource =
 * WALLET` + a unified `WalletEntry` ledger. This file is a compatibility
 * shim that delegates to `lib/api/organizations/wallet.ts`. Callers should
 * migrate to the wallet helpers directly.
 *
 * Parameter mapping:
 *   - `organizationProfileId` → `billingAccountId`
 *   - `memberProfileId`       → `membershipId`
 *
 * The shim expects callers to already pass a BillingAccount id; do NOT
 * pass the legacy OrganizationProfile id. API-route rewrites in Phase 2
 * resolve the BillingAccount before calling this.
 */

import type { Prisma } from "@prisma/client";
import { walletCredit, walletDebit } from "../../api/organizations/wallet";

type TxClient = Prisma.TransactionClient;

export async function deductCredits(
  tx: TxClient,
  billingAccountId: string,
  amountPaise: number,
  paymentId?: string,
  membershipId?: string,
): Promise<{ balanceAfter: number }> {
  return walletDebit(tx, {
    billingAccountId,
    amountPaise,
    reason: "BOOKING",
    paymentId,
    membershipId,
  });
}

export async function creditRefund(
  tx: TxClient,
  billingAccountId: string,
  amountPaise: number,
  paymentId?: string,
  membershipId?: string,
): Promise<{ balanceAfter: number }> {
  return walletCredit(tx, {
    billingAccountId,
    amountPaise,
    reason: "REFUND",
    paymentId,
    membershipId,
  });
}

export async function purchaseCredits(
  tx: TxClient,
  billingAccountId: string,
  creditsPaise: number,
  paymentId?: string,
): Promise<{ balanceAfter: number }> {
  return walletCredit(tx, {
    billingAccountId,
    amountPaise: creditsPaise,
    reason: "TOPUP",
    paymentId,
  });
}
