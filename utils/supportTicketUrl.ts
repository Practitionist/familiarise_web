import { SupportIssueType, SupportPriority } from "@prisma/client";

/**
 * Support ticket URL utility for contextual ticket creation
 * Generates URLs with pre-filled context from appointments/payments
 */

export type AppointmentStatus = "COMPLETED" | "UPCOMING";

/**
 * Priority options for support tickets
 */
export const PRIORITY_OPTIONS: {
  value: SupportPriority;
  label: string;
  color: string;
}[] = [
  { value: "LOW", label: "Low", color: "text-green-600" },
  { value: "MEDIUM", label: "Medium", color: "text-amber-600" },
  { value: "HIGH", label: "High", color: "text-orange-600" },
  { value: "URGENT", label: "Urgent", color: "text-red-600" },
];

/**
 * Issue types filtered by context
 * Based on GitHub Issue #298 requirements
 */
export const CONTEXTUAL_ISSUE_TYPES = {
  COMPLETED: [
    SupportIssueType.CONSULTANT_NO_SHOW,
    SupportIssueType.CONSULTANT_LATE,
    SupportIssueType.SESSION_ENDED_EARLY,
    SupportIssueType.SESSION_QUALITY_POOR,
    SupportIssueType.COMMUNICATION_ISSUE,
    SupportIssueType.TECHNICAL_ISSUES,
    SupportIssueType.OTHER,
  ],
  UPCOMING: [
    SupportIssueType.WANT_TO_CANCEL,
    SupportIssueType.RESCHEDULING_HELP,
    SupportIssueType.ACCESS_ISSUE,
    SupportIssueType.TIMEZONE_CONFUSION,
    SupportIssueType.TECHNICAL_ISSUES,
    SupportIssueType.OTHER,
  ],
  PAYMENT: [
    SupportIssueType.CHARGED_TWICE,
    SupportIssueType.REFUND_REQUEST,
    SupportIssueType.PAYMENT_FAILED,
    SupportIssueType.BILLING_QUESTION,
    SupportIssueType.OTHER,
  ],
} as const;

/**
 * All available issue types for generic support
 */
export const ALL_ISSUE_TYPES = Object.values(SupportIssueType);

export interface AppointmentContext {
  appointmentId: string;
  appointmentType: "CONSULTATION" | "SUBSCRIPTION" | "WEBINAR";
  status: AppointmentStatus;
  consultantName?: string;
  scheduledAt?: string;
}

export interface PaymentContext {
  paymentId: string;
}

export type SupportContext =
  | { type: "appointment"; context: AppointmentContext }
  | { type: "payment"; context: PaymentContext };

/**
 * Generate URL for contextual support ticket creation
 * @param consulteeId - The consultee's profile ID
 * @param context - Appointment or payment context
 * @returns URL string with query parameters
 */
export function generateSupportTicketUrl(
  consulteeId: string,
  context: SupportContext,
): string {
  const params = new URLSearchParams();
  params.set("tab", "support");

  if (context.type === "appointment") {
    const {
      appointmentId,
      appointmentType,
      status,
      consultantName,
      scheduledAt,
    } = context.context;
    params.set("appointmentId", appointmentId);
    params.set("appointmentType", appointmentType);
    params.set("appointmentStatus", status);
    if (consultantName) params.set("consultantName", consultantName);
    if (scheduledAt) params.set("scheduledAt", scheduledAt);
  } else if (context.type === "payment") {
    params.set("paymentId", context.context.paymentId);
  }

  return `/dashboard/consultee/${consulteeId}/feedback?${params.toString()}`;
}

/**
 * Get filtered issue types based on context
 * @param appointmentStatus - COMPLETED or UPCOMING
 * @param isPayment - Whether this is a payment-related issue
 * @returns Array of applicable SupportIssueType values
 */
export function getFilteredIssueTypes(
  appointmentStatus?: AppointmentStatus,
  isPayment?: boolean,
): SupportIssueType[] {
  if (isPayment) {
    return [...CONTEXTUAL_ISSUE_TYPES.PAYMENT];
  }

  if (appointmentStatus === "COMPLETED") {
    return [...CONTEXTUAL_ISSUE_TYPES.COMPLETED];
  }

  if (appointmentStatus === "UPCOMING") {
    return [...CONTEXTUAL_ISSUE_TYPES.UPCOMING];
  }

  return ALL_ISSUE_TYPES;
}

/**
 * Human-readable labels for issue types
 */
export const ISSUE_TYPE_LABELS: Record<SupportIssueType, string> = {
  // Session Issues
  [SupportIssueType.CONSULTANT_NO_SHOW]: "Consultant didn't show up",
  [SupportIssueType.CONSULTANT_LATE]: "Consultant was late",
  [SupportIssueType.SESSION_ENDED_EARLY]: "Session ended earlier than expected",
  [SupportIssueType.SESSION_QUALITY_POOR]: "Poor session quality",
  [SupportIssueType.COMMUNICATION_ISSUE]: "Audio/video problems during call",
  [SupportIssueType.TECHNICAL_ISSUES]: "Technical issues",
  [SupportIssueType.WRONG_CONSULTANT]: "Wrong consultant assigned",

  // Access & Scheduling
  [SupportIssueType.ACCESS_ISSUE]: "Cannot join or access session",
  [SupportIssueType.TIMEZONE_CONFUSION]: "Wrong time zone displayed",
  [SupportIssueType.RESCHEDULING_HELP]: "Need help rescheduling",

  // Payment Issues
  [SupportIssueType.PAYMENT_FAILED]: "Payment failed",
  [SupportIssueType.CHARGED_TWICE]: "Charged twice",
  [SupportIssueType.REFUND_REQUEST]: "Refund request",
  [SupportIssueType.BILLING_QUESTION]: "Invoice or receipt inquiry",

  // Documents
  [SupportIssueType.DOCUMENT_ISSUE]: "Materials not received or incorrect",

  // Cancellation
  [SupportIssueType.WANT_TO_CANCEL]: "Want to cancel booking",
  [SupportIssueType.CANCELLATION_ISSUE]: "Issue with cancellation",

  // General
  [SupportIssueType.ACCOUNT_ISSUE]: "Account issue",
  [SupportIssueType.GENERAL_INQUIRY]: "General inquiry",
  [SupportIssueType.OTHER]: "Other",
};

/**
 * Issue type categories for grouped display
 */
export const ISSUE_TYPE_CATEGORIES = {
  "Session Issues": [
    SupportIssueType.CONSULTANT_NO_SHOW,
    SupportIssueType.CONSULTANT_LATE,
    SupportIssueType.SESSION_ENDED_EARLY,
    SupportIssueType.SESSION_QUALITY_POOR,
    SupportIssueType.COMMUNICATION_ISSUE,
    SupportIssueType.TECHNICAL_ISSUES,
    SupportIssueType.WRONG_CONSULTANT,
  ],
  "Access & Scheduling": [
    SupportIssueType.ACCESS_ISSUE,
    SupportIssueType.TIMEZONE_CONFUSION,
    SupportIssueType.RESCHEDULING_HELP,
  ],
  "Payment Issues": [
    SupportIssueType.PAYMENT_FAILED,
    SupportIssueType.CHARGED_TWICE,
    SupportIssueType.REFUND_REQUEST,
    SupportIssueType.BILLING_QUESTION,
  ],
  Documents: [SupportIssueType.DOCUMENT_ISSUE],
  Cancellation: [
    SupportIssueType.WANT_TO_CANCEL,
    SupportIssueType.CANCELLATION_ISSUE,
  ],
  General: [
    SupportIssueType.ACCOUNT_ISSUE,
    SupportIssueType.GENERAL_INQUIRY,
    SupportIssueType.OTHER,
  ],
} as const;

/**
 * Get grouped issue types for dropdown display
 * Filters by context if provided
 */
export function getGroupedIssueTypes(
  appointmentStatus?: AppointmentStatus,
  isPayment?: boolean,
): Record<string, SupportIssueType[]> {
  const allowedTypes = getFilteredIssueTypes(appointmentStatus, isPayment);
  const result: Record<string, SupportIssueType[]> = {};

  for (const [category, types] of Object.entries(ISSUE_TYPE_CATEGORIES)) {
    const filteredTypes = types.filter((t) => allowedTypes.includes(t));
    if (filteredTypes.length > 0) {
      result[category] = filteredTypes;
    }
  }

  return result;
}
