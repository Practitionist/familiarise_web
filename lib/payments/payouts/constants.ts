/**
 * Payout-related constants used across the payout system
 */

// ============================================================================
// Platform Revenue Share
// ============================================================================

export const PAYOUT_CONSTANTS = {
  /** Platform fee percentage (20%) */
  PLATFORM_FEE_PERCENTAGE: 20,

  /** Consultant share percentage (80%) */
  CONSULTANT_SHARE_PERCENTAGE: 80,

  /** Minimum payout amount in paise (₹500) */
  MINIMUM_PAYOUT_AMOUNT: 50000,

  /** Auto-approve threshold in paise (₹5000) - below this, auto-approve */
  AUTO_APPROVE_THRESHOLD: 500000,

  /** Hold periods in hours before earnings become payable */
  HOLD_PERIOD_HOURS: {
    CONSULTATION: 24, // 24 hours after consultation
    WEBINAR: 48, // 48 hours after webinar ends
    SUBSCRIPTION: 168, // 7 days for subscriptions
    CLASS: 24, // 24 hours after class ends
  } as const,

  /** Maximum retry attempts for failed payouts */
  MAX_RETRY_ATTEMPTS: 3,
} as const;

// ============================================================================
// GST/Tax Constants
// ============================================================================

export const TAX_CONSTANTS = {
  /** GST rate for consulting services (18%) */
  GST_RATE: 18,

  /** SAC code for consulting services */
  SAC_CODE: "999293",

  /** HSN codes for different service types */
  HSN_CODES: {
    CONSULTING: "999293", // SAC for consulting services
    EDUCATION: "999294", // SAC for educational services
    TRAINING: "999295", // SAC for training services
  } as const,
} as const;

// ============================================================================
// Payout Modes
// ============================================================================

export const PAYOUT_MODES = {
  /** IMPS: Instant transfer up to ₹5L */
  IMPS_LIMIT: 50000000, // ₹5L in paise

  /** RTGS: Real-time for amounts > ₹2L */
  RTGS_MIN: 20000000, // ₹2L in paise
} as const;

// ============================================================================
// Type exports for TypeScript
// ============================================================================

export type AppointmentType = keyof typeof PAYOUT_CONSTANTS.HOLD_PERIOD_HOURS;
