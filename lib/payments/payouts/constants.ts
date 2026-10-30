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
    DIGITAL_PRODUCT: 168, // 7 days after a digital product sale
  } as const,

  /** Maximum retry attempts for failed payouts */
  MAX_RETRY_ATTEMPTS: 3,

  /** Extra hold days on a new expert's earnings. */
  NEW_EXPERT_EXTRA_HOLD_DAYS: 7,
  /** An expert is new while their first paid earning is younger than this. */
  NEW_EXPERT_TENURE_DAYS: 30,
  /** ...or while their lifetime non-refunded share is below this (₹50,000). */
  NEW_EXPERT_LIFETIME_SHARE_PAISE: 5_000_000,

  /** A consultant owing more than this clawback (₹10,000) is not paid out. */
  CLAWBACK_RECOVERY_PAUSE_PAISE: 1_000_000,
} as const;

/** Instant payouts at or below this (default ₹5,000, env-overridable) send at once; larger ones queue for admin approval. */
export const INSTANT_PAYOUT_AUTO_APPROVE_PAISE = (() => {
  const fromEnv = Number(process.env.INSTANT_PAYOUT_AUTO_APPROVE_PAISE);
  return Number.isSafeInteger(fromEnv) && fromEnv > 0
    ? fromEnv
    : PAYOUT_CONSTANTS.AUTO_APPROVE_THRESHOLD;
})();

// ============================================================================
// GST/Tax Constants
// ============================================================================

export const TAX_CONSTANTS = {
  /** GST rate for consulting services (18%) */
  GST_RATE: 18,

  /** SAC 999293: commercial training and coaching services (the platform default). */
  SAC_CODE: "999293",

  /** SAC codes keyed by service type; 998311 (management consulting) is not emitted yet. */
  HSN_CODES: {
    CONSULTING: "999293", // commercial training and coaching services
    EDUCATION: "999294", // other education and training services n.e.c.
    TRAINING: "999295", // services involving conduct of examinations for admission
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
