// Business logic constants and configuration

export const PAYMENT_CONFIG = {
  // Payment intent expiration time (30 minutes)
  PAYMENT_INTENT_EXPIRY_MS: 30 * 60 * 1000,
  
  // Maximum payment processing time (2 hours)
  MAX_PAYMENT_PROCESSING_TIME_MS: 2 * 60 * 60 * 1000,
  
  // Payment amount tolerance for verification (1 cent)
  AMOUNT_VERIFICATION_TOLERANCE: 0.01,
  
  // Default currency
  DEFAULT_CURRENCY: "USD",
  
  // Supported payment gateways
  SUPPORTED_GATEWAYS: ["STRIPE", "RAZORPAY", "LEMON_SQUEEZY", "XFLOW", "CARD"] as const,
  
  // Gateway-specific configurations
  GATEWAY_CONFIG: {
    STRIPE: {
      supportedCurrencies: ["USD", "EUR", "GBP", "CAD", "AUD"],
      feePercentage: 2.9,
      fixedFee: 0.30,
    },
    RAZORPAY: {
      supportedCurrencies: ["INR"],
      feePercentage: 2.0,
      fixedFee: 0,
    },
    LEMON_SQUEEZY: {
      supportedCurrencies: ["USD", "EUR"],
      feePercentage: 5.0,
      fixedFee: 0.50,
    },
    XFLOW: {
      supportedCurrencies: ["USD"],
      feePercentage: 2.5,
      fixedFee: 0.25,
    },
    CARD: {
      supportedCurrencies: ["USD", "EUR", "GBP", "CAD", "AUD"],
      feePercentage: 3.0,
      fixedFee: 0,
    },
  },
} as const;

export const APPOINTMENT_CONFIG = {
  // Minimum advance booking times (in hours)
  MIN_ADVANCE_BOOKING: {
    CONSULTATION: 1,
    SUBSCRIPTION: 24,
    WEBINAR: 2,
    CLASS: 12,
  },
  
  // Maximum appointment durations (in hours)
  MAX_DURATION: {
    CONSULTATION: 4,
    SUBSCRIPTION: 2,
    WEBINAR: 8,
    CLASS: 8,
  },
  
  // Minimum appointment durations (in minutes)
  MIN_DURATION: {
    CONSULTATION: 30,
    SUBSCRIPTION: 60,
    WEBINAR: 30,
    CLASS: 60,
  },
  
  // Default durations (in hours)
  DEFAULT_DURATION: {
    CONSULTATION: 1,
    SUBSCRIPTION: 1,
    WEBINAR: 1,
    CLASS: 2,
  },
  
  // Maximum participants for group events
  MAX_PARTICIPANTS: {
    CONSULTATION: 1,
    SUBSCRIPTION: 1,
    WEBINAR: 1000,
    CLASS: 50,
  },
  
  // Default participant limits
  DEFAULT_MAX_PARTICIPANTS: {
    WEBINAR: 100,
    CLASS: 25,
  },
} as const;

export const RATE_LIMITING_CONFIG = {
  // Checkout attempts
  CHECKOUT: {
    windowMs: 5 * 60 * 1000, // 5 minutes
    maxAttempts: 10,
  },
  
  // Slot-specific checkout attempts
  CHECKOUT_PER_SLOT: {
    windowMs: 60 * 1000, // 1 minute
    maxAttempts: 3,
  },
  
  // Webhook endpoints
  WEBHOOK: {
    windowMs: 60 * 1000, // 1 minute
    maxAttempts: 100,
  },
  
  // API endpoints (general)
  API_GENERAL: {
    windowMs: 60 * 1000, // 1 minute
    maxAttempts: 60,
  },
  
  // Login attempts
  LOGIN: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxAttempts: 5,
  },
} as const;

export const CLEANUP_CONFIG = {
  // How often to run cleanup jobs (in minutes)
  CLEANUP_INTERVAL_MINUTES: 15,
  
  // How long to keep expired payments before cleanup (in minutes)
  EXPIRED_PAYMENT_RETENTION_MINUTES: 30,
  
  // How long to keep orphaned slots (in minutes)
  ORPHANED_SLOT_RETENTION_MINUTES: 30,
  
  // Maximum tentative bookings per slot
  MAX_TENTATIVE_BOOKINGS_PER_SLOT: 3,
  
  // Webhook event retention (for replay protection)
  WEBHOOK_EVENT_RETENTION_MINUTES: 5,
  
  // Payment intent tracking retention
  PAYMENT_INTENT_TRACKING_RETENTION_HOURS: 1,
} as const;

export const VALIDATION_CONFIG = {
  // String length limits
  MAX_LENGTHS: {
    PLAN_TITLE: 100,
    PLAN_DESCRIPTION: 1000,
    USER_NAME: 50,
    EMAIL: 254,
    PHONE: 20,
    NOTES: 500,
    DISCOUNT_CODE: 20,
  },
  
  // Minimum lengths
  MIN_LENGTHS: {
    PASSWORD: 8,
    PLAN_TITLE: 3,
    USER_NAME: 2,
    DISCOUNT_CODE: 3,
  },
  
  // Numeric limits
  NUMERIC_LIMITS: {
    MIN_PRICE: 1, // $1 minimum
    MAX_PRICE: 10000, // $10,000 maximum
    MIN_DURATION_HOURS: 0.5, // 30 minutes
    MAX_DURATION_HOURS: 8, // 8 hours
    MAX_PARTICIPANTS: 1000,
  },
} as const;

export const NOTIFICATION_CONFIG = {
  // Email notification delays
  EMAIL_DELAYS: {
    PAYMENT_SUCCESS: 0, // Immediate
    PAYMENT_FAILED: 0, // Immediate
    APPOINTMENT_REMINDER: 24 * 60 * 60 * 1000, // 24 hours before
    APPOINTMENT_FOLLOWUP: 24 * 60 * 60 * 1000, // 24 hours after
  },
  
  // Retry configurations
  EMAIL_RETRY: {
    maxRetries: 3,
    backoffMs: 5000, // 5 seconds
  },
  
  // Notification priorities
  PRIORITIES: {
    PAYMENT_FAILED: "high",
    APPOINTMENT_CANCELLED: "high",
    PAYMENT_SUCCESS: "medium",
    APPOINTMENT_CONFIRMED: "medium",
    APPOINTMENT_REMINDER: "medium",
    GENERAL: "low",
  },
} as const;

export const SECURITY_CONFIG = {
  // Password requirements
  PASSWORD: {
    minLength: 8,
    requireUppercase: true,
    requireLowercase: true,
    requireNumbers: true,
    requireSpecialChars: false,
  },
  
  // Session configuration
  SESSION: {
    maxAgeSeconds: 7 * 24 * 60 * 60, // 7 days
    renewThresholdSeconds: 24 * 60 * 60, // Renew if less than 1 day remaining
  },
  
  // API key lengths
  API_KEY_LENGTHS: {
    WEBHOOK_SECRET: 32,
    CLEANUP_API_KEY: 32,
  },
  
  // Allowed file types for uploads
  ALLOWED_FILE_TYPES: {
    IMAGES: ["image/jpeg", "image/png", "image/gif", "image/webp"],
    DOCUMENTS: ["application/pdf", "text/plain"],
  },
  
  // File size limits (in bytes)
  FILE_SIZE_LIMITS: {
    PROFILE_IMAGE: 5 * 1024 * 1024, // 5MB
    DOCUMENT: 10 * 1024 * 1024, // 10MB
  },
} as const;

export const TIME_CONFIG = {
  // Timezone handling
  DEFAULT_TIMEZONE: "UTC",
  
  // Business hours (24-hour format)
  BUSINESS_HOURS: {
    start: 9, // 9 AM
    end: 18, // 6 PM
  },
  
  // Days of operation
  BUSINESS_DAYS: [1, 2, 3, 4, 5], // Monday to Friday (0 = Sunday)
  
  // Slot duration options (in minutes)
  SLOT_DURATIONS: [30, 45, 60, 90, 120, 180, 240],
  
  // Time slot buffer (in minutes)
  SLOT_BUFFER_MINUTES: 15,
} as const;

export const ERROR_MESSAGES = {
  // Authentication errors
  AUTH: {
    UNAUTHORIZED: "Authentication required",
    FORBIDDEN: "Access denied",
    INVALID_CREDENTIALS: "Invalid email or password",
    ACCOUNT_LOCKED: "Account temporarily locked due to multiple failed attempts",
  },
  
  // Payment errors
  PAYMENT: {
    AMOUNT_MISMATCH: "Payment amount verification failed",
    GATEWAY_ERROR: "Payment gateway temporarily unavailable",
    INSUFFICIENT_FUNDS: "Payment declined - insufficient funds",
    EXPIRED_CARD: "Payment declined - card expired",
    PROCESSING_ERROR: "Payment processing failed",
  },
  
  // Booking errors
  BOOKING: {
    SLOT_UNAVAILABLE: "Selected time slot is not available",
    PAST_BOOKING: "Cannot book appointments in the past",
    DURATION_TOO_SHORT: "Appointment duration is too short",
    DURATION_TOO_LONG: "Appointment duration exceeds maximum allowed",
    INSUFFICIENT_ADVANCE: "Insufficient advance notice for booking",
    EVENT_FULL: "Event has reached maximum capacity",
  },
  
  // Validation errors
  VALIDATION: {
    REQUIRED_FIELD: "This field is required",
    INVALID_EMAIL: "Invalid email address format",
    INVALID_PHONE: "Invalid phone number format",
    PASSWORD_TOO_WEAK: "Password does not meet security requirements",
    INVALID_DATE: "Invalid date format",
    INVALID_TIME: "Invalid time format",
  },
  
  // System errors
  SYSTEM: {
    DATABASE_ERROR: "Database operation failed",
    EXTERNAL_SERVICE_ERROR: "External service temporarily unavailable",
    RATE_LIMIT_EXCEEDED: "Too many requests - please try again later",
    MAINTENANCE_MODE: "System is currently under maintenance",
  },
} as const;

// Export type-safe constants
export type PaymentGateway = typeof PAYMENT_CONFIG.SUPPORTED_GATEWAYS[number];
export type AppointmentType = keyof typeof APPOINTMENT_CONFIG.MIN_ADVANCE_BOOKING;
export type NotificationPriority = "high" | "medium" | "low";

// Utility functions for working with constants
export const Constants = {
  // Get minimum advance booking time for appointment type
  getMinAdvanceBooking: (type: AppointmentType): number => {
    return APPOINTMENT_CONFIG.MIN_ADVANCE_BOOKING[type];
  },
  
  // Get payment gateway configuration
  getGatewayConfig: (gateway: PaymentGateway) => {
    return PAYMENT_CONFIG.GATEWAY_CONFIG[gateway as keyof typeof PAYMENT_CONFIG.GATEWAY_CONFIG];
  },
  
  // Check if currency is supported by gateway
  isCurrencySupported: (gateway: PaymentGateway, currency: string): boolean => {
    const config = PAYMENT_CONFIG.GATEWAY_CONFIG[gateway as keyof typeof PAYMENT_CONFIG.GATEWAY_CONFIG];
    return config ? (config.supportedCurrencies as readonly string[]).includes(currency) : false;
  },
  
  // Get rate limit configuration
  getRateLimitConfig: (endpoint: keyof typeof RATE_LIMITING_CONFIG) => {
    return RATE_LIMITING_CONFIG[endpoint];
  },
};