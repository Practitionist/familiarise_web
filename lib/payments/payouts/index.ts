/**
 * Payout System Exports
 * Central export point for all payout-related functionality
 */

// Constants
export { PAYOUT_CONSTANTS, TAX_CONSTANTS, PAYOUT_MODES } from "./constants";
export type { AppointmentType } from "./constants";

// RazorpayX Payouts
export {
  RazorpayPayoutsService,
  getRazorpayPayoutsService,
  isRazorpayPayoutsConfigured,
} from "./razorpay-payouts";
export type {
  RazorpayXConfig,
  CreateContactRequest,
  Contact,
  CreateFundAccountRequest,
  FundAccount,
  CreatePayoutRequest,
  RazorpayPayout,
  RazorpayPayoutStatus,
  PayoutWebhookEvent,
} from "./razorpay-payouts";

// Stripe Connect
export {
  StripeConnectService,
  getStripeConnectService,
  isStripeConnectConfigured,
} from "./stripe-connect";
export type {
  StripeConnectConfig,
  CreateConnectedAccountRequest,
  ConnectedAccount,
  CreateAccountLinkRequest,
  AccountLink,
  CreateTransferRequest,
  StripeTransfer,
  StripePayout,
} from "./stripe-connect";

// Payout Service
export {
  getPendingPayouts,
  getPayoutById,
  checkPayoutEligibility,
  createPayoutBatch,
  approvePayout,
  rejectPayout,
  processApprovedPayouts,
  handlePayoutWebhook,
  getPayoutStats,
} from "./payout-service";
export type {
  PayoutSummary,
  PayoutResult,
  BatchResult,
  ConsultantPayoutEligibility,
} from "./payout-service";

// Org Payout Service
export {
  getOrgPayoutEligibility,
  createOrgPayoutBatch,
  processOrgPayout,
  markOrgPayoutCompleted,
  markOrgPayoutFailed,
  markOrgPayoutReversed,
} from "./org-payout-service";
export type {
  OrgPayoutEligibility,
  OrgPayoutBatchResult,
} from "./org-payout-service";

// Earnings Service
export {
  createEarningsFromPayment,
  releaseEarningsFromHold,
  getConsultantEarningsSummary,
  getConsultantEarnings,
  refundEarnings,
  holdEarnings,
  releaseHeldEarnings,
  getEarningsStats,
  // Organization earnings (PROVIDER/HYBRID 3-way split)
  getOrgEarningsSummary,
  getOrgEarnings,
} from "./earnings-service";
export type {
  EarningsSummary,
  CreateEarningsParams,
  OrgEarningsSplit,
  OrgEarningsSummary,
} from "./earnings-service";

