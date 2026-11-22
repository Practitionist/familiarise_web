// What the orchestrator hands the checkout transaction.

import type { CheckoutInput } from "@/schemas/checkout";
import type { calculateAmountAndValidate } from "@/lib/payments/checkout/pricing";
import type { OrgFundingGate } from "@/lib/payments/checkout/org-funding";
import type { PreparedSeatNotice } from "@/lib/payments/checkout/free-seat-notice";

export interface CheckoutCommitInput {
  validatedData: CheckoutInput;
  userId: string;
  isMockPayment: boolean;
  mintedOrder: { id: string; client_secret: string | null };
  holdExpiresAt: Date;
  renewOrAbort: (ttl: number) => Promise<void>;
  perAttemptTtl: number;
  checkoutTxTimeoutMs: number;
  organizationId: string | null;
  billingAccountId: string | null;
  fundingSource: OrgFundingGate["fundingSource"];
  programAssignmentId: string | null;
  callerMembershipId: string | null;
  creditEffectiveLimit: number | null;
  isOrgWalletPayment: boolean;
  isOrgInvoicedPayment: boolean;
  isOrgLicensedPayment: boolean;
  isOrgSponsoredPayment: boolean;
  isZeroAmountPayment: boolean;
  displayCurrencyAtCheckout: string;
  exchangeRateAtCheckout: number | null;
  exhaustedBell: { programAssignmentId: string | null };
  priced: Awaited<ReturnType<typeof calculateAmountAndValidate>>;
  /** A free event seat's booked notice, rendered before the commit opens; null otherwise. */
  preparedSeatNotice: PreparedSeatNotice | null;
}
