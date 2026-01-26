/**
 * Test Case Definitions for Seed Data
 *
 * This module defines edge cases, corner cases, and test case generators
 * that can be integrated into seed files to create comprehensive test data.
 *
 * Test Case Distribution:
 * - 5% edge cases (boundary conditions)
 * - 2% corner cases (unusual but valid combinations)
 * - 93% realistic/average cases
 */

import { faker } from "@faker-js/faker";

export type TestCaseType = "realistic" | "average" | "edge" | "corner";

/**
 * Determines the test case type for a given index based on distribution percentages
 */
export function getTestCaseType(index: number, total: number): TestCaseType {
  const edgeThreshold = Math.floor(total * 0.05); // First 5% are edge cases
  const cornerThreshold = edgeThreshold + Math.floor(total * 0.02); // Next 2% are corner cases

  if (index < edgeThreshold) return "edge";
  if (index < cornerThreshold) return "corner";

  // Remaining 93% alternates between realistic and average
  return index % 2 === 0 ? "realistic" : "average";
}

/**
 * Returns metadata for the test case type (useful for tracking)
 */
export function getTestCaseMetadata(
  type: TestCaseType,
  name?: string,
): { testCaseType: TestCaseType; testCaseName?: string } {
  return {
    testCaseType: type,
    testCaseName: name,
  };
}

// =============================================================================
// APPOINTMENT EDGE CASES
// =============================================================================

export const appointmentEdgeCases = {
  /**
   * Maximum duration appointment (8 hours)
   */
  maxDuration: {
    name: "max_duration_appointment",
    description: "Appointment at maximum allowed duration (8 hours)",
    getDurationMinutes: () => 480, // 8 hours
  },

  /**
   * Minimum duration appointment (15 minutes)
   */
  minDuration: {
    name: "min_duration_appointment",
    description: "Appointment at minimum allowed duration (15 minutes)",
    getDurationMinutes: () => 15,
  },

  /**
   * Appointment starting at midnight boundary
   */
  midnightStart: {
    name: "midnight_start_appointment",
    description: "Appointment starting at exactly midnight",
    getStartHour: () => 0,
    getStartMinute: () => 0,
  },

  /**
   * Appointment ending at end of day
   */
  endOfDay: {
    name: "end_of_day_appointment",
    description: "Appointment ending at 23:59",
    getEndHour: () => 23,
    getEndMinute: () => 59,
  },

  /**
   * Appointment on year boundary (Dec 31 - Jan 1)
   */
  yearBoundary: {
    name: "year_boundary_appointment",
    description: "Appointment crossing year boundary",
    getDate: () => {
      const year = new Date().getFullYear();
      return new Date(year, 11, 31); // December 31
    },
  },

  /**
   * Appointment on leap day
   */
  leapDay: {
    name: "leap_day_appointment",
    description: "Appointment on February 29 (leap year)",
    getDate: () => {
      // Find next leap year
      let year = new Date().getFullYear();
      while (!isLeapYear(year)) year++;
      return new Date(year, 1, 29); // February 29
    },
  },
};

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// =============================================================================
// APPOINTMENT CORNER CASES
// =============================================================================

export const appointmentCornerCases = {
  /**
   * Back-to-back appointments with no gap
   */
  backToBack: {
    name: "back_to_back_sessions",
    description: "Multiple back-to-back appointments with no gap",
    generateSlotPairs: (baseTime: Date, count: number = 3) => {
      const slots = [];
      let currentTime = new Date(baseTime);

      for (let i = 0; i < count; i++) {
        const start = new Date(currentTime);
        const end = new Date(currentTime.getTime() + 60 * 60 * 1000); // 1 hour later
        slots.push({ start, end });
        currentTime = end; // Next slot starts when this one ends
      }
      return slots;
    },
  },

  /**
   * Last minute booking (within 1 hour of start)
   */
  lastMinute: {
    name: "last_minute_booking",
    description: "Booking made within 1 hour of appointment start",
    getCreatedAt: (appointmentStart: Date) => {
      // Created 30-59 minutes before start
      const minutesBefore = faker.number.int({ min: 30, max: 59 });
      return new Date(appointmentStart.getTime() - minutesBefore * 60 * 1000);
    },
  },

  /**
   * Very far future appointment (6+ months away)
   */
  farFuture: {
    name: "far_future_appointment",
    description: "Appointment scheduled 6+ months in advance",
    getDate: () => {
      const now = new Date();
      const monthsAhead = faker.number.int({ min: 6, max: 12 });
      return new Date(
        now.getFullYear(),
        now.getMonth() + monthsAhead,
        faker.number.int({ min: 1, max: 28 }),
      );
    },
  },

  /**
   * Appointment with maximum participants (for webinars)
   */
  maxParticipants: {
    name: "max_participants_webinar",
    description: "Webinar at maximum capacity (500)",
    getParticipantCount: () => 500,
  },
};

// =============================================================================
// PAYMENT EDGE CASES
// =============================================================================

export const paymentEdgeCases = {
  /**
   * Minimum payment amount (1 INR = 100 paise)
   */
  minimumAmount: {
    name: "minimum_payment",
    description: "Payment at minimum amount (1 INR)",
    getAmount: () => 100, // 1 INR in paise
    getCurrency: () => "INR",
  },

  /**
   * Maximum practical payment amount
   */
  maximumAmount: {
    name: "maximum_payment",
    description: "Payment at maximum practical amount (999,999 INR)",
    getAmount: () => 99999900, // 999,999 INR in paise
    getCurrency: () => "INR",
  },

  /**
   * Payment with 100% discount
   */
  fullDiscount: {
    name: "full_discount_payment",
    description: "Payment with 100% discount applied (0 final amount)",
    getDiscountPercentage: () => 100,
    getFinalAmount: () => 0,
  },

  /**
   * Multi-currency payment (USD)
   */
  usdPayment: {
    name: "usd_payment",
    description: "Payment in USD currency",
    getCurrency: () => "USD",
    getAmount: () => faker.number.int({ min: 1000, max: 50000 }), // $10-$500 in cents
  },

  /**
   * Multi-currency payment (EUR)
   */
  eurPayment: {
    name: "eur_payment",
    description: "Payment in EUR currency",
    getCurrency: () => "EUR",
    getAmount: () => faker.number.int({ min: 1000, max: 50000 }), // 10-500 EUR in cents
  },
};

// =============================================================================
// PAYMENT CORNER CASES
// =============================================================================

export const paymentCornerCases = {
  /**
   * Partial refund scenario
   */
  partialRefund: {
    name: "partial_refund",
    description: "Payment with partial refund (50%)",
    getRefundPercentage: () => 50,
  },

  /**
   * Multiple partial refunds on same payment
   */
  multiplePartialRefunds: {
    name: "multiple_partial_refunds",
    description: "Payment with multiple partial refunds",
    getRefundPercentages: () => [25, 25, 25], // Three 25% refunds = 75% total
  },

  /**
   * Payment with dispute followed by resolution
   */
  disputeResolved: {
    name: "dispute_resolved",
    description: "Payment that was disputed and then resolved",
    getDisputeStatus: () => "RESOLVED",
  },

  /**
   * Payment at exact discount threshold
   */
  exactThreshold: {
    name: "exact_discount_threshold",
    description: "Payment amount exactly at discount minimum threshold",
    getAmount: (minPurchaseAmount: number) => minPurchaseAmount,
  },
};

// =============================================================================
// USER EDGE CASES
// =============================================================================

export const userEdgeCases = {
  /**
   * Maximum length name (255 characters)
   */
  maxLengthName: {
    name: "max_length_name",
    description: "User with maximum allowed name length",
    getName: () => faker.person.firstName() + " " + "A".repeat(240),
  },

  /**
   * Name with special characters
   */
  specialCharactersName: {
    name: "special_characters_name",
    description: "User with special characters in name (O'Brien, José)",
    getName: () =>
      faker.helpers.arrayElement([
        "Patrick O'Brien",
        "José García",
        "Marie-Claire Dupont",
        "Müller Schmidt",
        "Björk Guðmundsdóttir",
        "Nguyễn Văn Minh",
      ]),
  },

  /**
   * Brand new consultant with no reviews
   */
  newConsultant: {
    name: "new_consultant_no_reviews",
    description: "New consultant with 0 reviews and no rating",
    getRating: () => null,
    getReviewCount: () => 0,
    getExperience: () => 0.5, // 6 months
  },

  /**
   * Highly experienced consultant (max experience)
   */
  veteranConsultant: {
    name: "veteran_consultant",
    description: "Consultant with maximum experience (25 years)",
    getExperience: () => 25,
    getRating: () => 5.0,
    getTotalMenteesHelped: () => 500,
  },
};

// =============================================================================
// USER CORNER CASES
// =============================================================================

export const userCornerCases = {
  /**
   * User who is both consultant and consultee
   * Note: This requires special handling as the schema may not support it directly
   */
  dualRole: {
    name: "consultant_and_consultee",
    description: "User who operates as both consultant and consultee",
    note: "Requires two separate user accounts with same contact info",
  },

  /**
   * Consultant with all 4 plan types
   */
  allPlanTypes: {
    name: "all_plan_types_consultant",
    description: "Consultant offering all 4 plan types",
    getPlanTypes: () =>
      ["consultation", "subscription", "webinar", "class"] as const,
  },

  /**
   * Consultant with only 1 plan type
   */
  singlePlanType: {
    name: "single_plan_type_consultant",
    description: "Consultant offering only 1 plan type",
    getPlanTypes: () => ["consultation"] as const,
  },

  /**
   * Deactivated user with future appointments
   * Note: This tests data integrity handling
   */
  deactivatedWithAppointments: {
    name: "deactivated_with_appointments",
    description: "Deactivated user who still has future appointments",
    note: "Tests handling of orphaned appointments",
  },
};

// =============================================================================
// SUBSCRIPTION EDGE CASES
// =============================================================================

export const subscriptionEdgeCases = {
  /**
   * Maximum duration subscription (6 months)
   */
  maxDuration: {
    name: "max_duration_subscription",
    description: "Subscription at maximum duration (6 months)",
    getDurationMonths: () => 6,
  },

  /**
   * Maximum calls per week
   */
  maxCallsPerWeek: {
    name: "max_calls_subscription",
    description: "Subscription with maximum calls per week (7)",
    getCallsPerWeek: () => 7,
  },

  /**
   * Minimum subscription (1 month, 1 call/week)
   */
  minimumSubscription: {
    name: "min_subscription",
    description: "Minimum subscription configuration",
    getDurationMonths: () => 1,
    getCallsPerWeek: () => 1,
  },
};

// =============================================================================
// AVAILABILITY EDGE CASES
// =============================================================================

export const availabilityEdgeCases = {
  /**
   * Full day availability (9 AM - 9 PM)
   */
  fullDay: {
    name: "full_day_availability",
    description: "Consultant available all day (12 hours)",
    getStartHour: () => 9,
    getEndHour: () => 21,
  },

  /**
   * Minimal availability (1 hour slot)
   */
  minimalAvailability: {
    name: "minimal_availability",
    description: "Consultant with only 1 hour availability",
    getDurationHours: () => 1,
  },

  /**
   * Weekend-only availability
   */
  weekendOnly: {
    name: "weekend_only_availability",
    description: "Consultant available only on weekends",
    getDaysOfWeek: () => ["SATURDAY", "SUNDAY"] as const,
  },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Generates an edge case appointment based on the edge case index
 */
export function generateEdgeCaseAppointment(edgeCaseIndex: number) {
  const edgeCases = Object.values(appointmentEdgeCases);
  const selectedCase = edgeCases[edgeCaseIndex % edgeCases.length];
  return {
    ...selectedCase,
    isEdgeCase: true,
  };
}

/**
 * Generates a corner case appointment based on the corner case index
 */
export function generateCornerCaseAppointment(cornerCaseIndex: number) {
  const cornerCases = Object.values(appointmentCornerCases);
  const selectedCase = cornerCases[cornerCaseIndex % cornerCases.length];
  return {
    ...selectedCase,
    isCornerCase: true,
  };
}

/**
 * Generates an edge case payment based on the edge case index
 */
export function generateEdgeCasePayment(edgeCaseIndex: number) {
  const edgeCases = Object.values(paymentEdgeCases);
  const selectedCase = edgeCases[edgeCaseIndex % edgeCases.length];
  return {
    ...selectedCase,
    isEdgeCase: true,
  };
}

/**
 * Generates an edge case user based on the edge case index
 */
export function generateEdgeCaseUser(edgeCaseIndex: number) {
  const edgeCases = Object.values(userEdgeCases);
  const selectedCase = edgeCases[edgeCaseIndex % edgeCases.length];
  return {
    ...selectedCase,
    isEdgeCase: true,
  };
}

/**
 * Summary of all test case types for documentation
 */
export const testCaseSummary = {
  appointments: {
    edgeCases: Object.keys(appointmentEdgeCases),
    cornerCases: Object.keys(appointmentCornerCases),
  },
  payments: {
    edgeCases: Object.keys(paymentEdgeCases),
    cornerCases: Object.keys(paymentCornerCases),
  },
  users: {
    edgeCases: Object.keys(userEdgeCases),
    cornerCases: Object.keys(userCornerCases),
  },
  subscriptions: {
    edgeCases: Object.keys(subscriptionEdgeCases),
  },
  availability: {
    edgeCases: Object.keys(availabilityEdgeCases),
  },
};
