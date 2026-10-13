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
export type { Contact, RazorpayPayout } from "./razorpay-payouts";

// Payout Service
export {
  getPendingPayouts,
  getPayoutById,
  checkPayoutEligibility,
  createPayoutBatch,
  approvePayout,
  rejectPayout,
  processApprovedPayouts,
  REQUEST_PAYOUT_RUN_BOUNDS,
  handlePayoutWebhook,
  markConsultantPayoutReversed,
  getPayoutStats,
} from "./payout-service";
export type { PayoutResult } from "./payout-service";

// Org Payout Service
export {
  getOrgPayoutEligibility,
  createOrgPayoutBatch,
  createOrgPayoutBatches,
  approveOrgPayout,
  processOrgPayout,
  processPendingOrgPayouts,
  markOrgPayoutCompleted,
  markOrgPayoutFailed,
  markOrgPayoutReversed,
} from "./org-payout-service";
export type { OrgProcessingResult, OrgBatchResult } from "./org-payout-service";
export { PayoutMakerCheckerError } from "./shared-lifecycle";

// Earnings Service
export {
  createEarningsFromPayment,
  planEarningsForPayment,
  resolvePaymentForEarnings,
  getConsultantEarningsSummary,
  getConsultantEarnings,
  refundEarnings,
  getEarningsStats,
  // Organization earnings (PROVIDER/HYBRID 3-way split)
  getOrgEarningsSummary,
  getOrgEarnings,
} from "./earnings-service";
export type { PreplannedEarningsContext } from "./earnings-service";
