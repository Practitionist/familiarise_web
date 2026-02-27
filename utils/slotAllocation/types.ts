/**
 * Shared types for the unified slot allocation system
 *
 * This file consolidates all types used across allocation services to ensure
 * consistency and reduce duplication.
 */

import { AppointmentsType, Prisma } from "@prisma/client";

/**
 * Allocation modes supported by the system
 */
export type AllocationMode = "auto" | "manual" | "requested";

/**
 * Event types that can be allocated
 */
export type EventType = "consultation" | "subscription" | "webinar" | "class";

/**
 * Request structure for slot allocation
 */
export interface AllocationRequest {
  eventType: EventType;
  eventId: string;
  mode: AllocationMode;
  slots?: string[]; // ISO date strings for manual allocation
}

/**
 * Constraints for auto-allocation algorithm
 */
export interface AllocationConstraints {
  schedulingPeriodStartsAt: Date;
  schedulingPeriodEndsAt: Date;
  slotsRequired: number;
  sessionDurationInHours: number;
  callsPerWeek?: number; // For subscriptions/classes
  slotsPerCall?: number; // Calculated from sessionDurationInHours
  mustBeConsecutive?: boolean; // True for consultations/webinars
  mustBeSameDay?: boolean; // True for consultations
}

/**
 * Result of validation check
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Result of slot conflict checking — shared across all 4 event validate API routes,
 * the allocationService utility, and the RequestedSlotsDialog component.
 *
 * Routes with extra fields (subscription, class, dialog) extend this base.
 */
export interface SlotConflictResult {
  conflicts: Array<{
    slot: string;
    existingAppointment: {
      type: string;
      with: string;
      time: string;
    };
  }>;
  outsideAvailability: Array<{
    slot: string;
  }>;
  validSlots: string[];
}

/**
 * Result of allocation operation
 */
export interface AllocationResult {
  success: boolean;
  appointments?: any[]; // Appointment records created
  error?: string;
  warnings?: string[];
}

/**
 * Time slot representation
 */
export interface TimeSlot {
  startTime: Date;
  endTime: Date;
  isAvailable: boolean;
  isBooked: boolean;
}

/**
 * Progress information for UI display
 */
export interface ProgressInfo {
  scheduled: number; // Number of calls/sessions scheduled
  required: number; // Total required
  remaining: number; // Remaining to schedule
  sessionDuration: number; // In hours
  displayText: string; // Formatted text for UI
}

/**
 * Consultant profile data needed for allocation
 */
export interface ConsultantAllocationData {
  userId: string;
  scheduleType: "WEEKLY" | "CUSTOM";
  slotsOfAvailabilityWeekly: Array<{
    id: string;
    dayOfWeekForStartsAt: string;
    availabilityStartsAt: Date;
    availabilityEndsAt: Date;
  }>;
  slotsOfAvailabilityCustom: Array<{
    id: string;
    availabilityStartsAt: Date;
    availabilityEndsAt: Date;
  }>;
  timezone?: string;
}

/**
 * Event configuration for allocation
 */
export interface EventConfig {
  durationInMonths?: number;
  durationInHours?: number; // For consultations/webinars (total duration)
  sessionDurationInHours?: number; // For subscriptions/classes (per session)
  callsPerWeek?: number; // For subscriptions/classes
  totalSessions?: number; // Authoritative session count from subscription plan
  schedulingPeriodStartsAt?: Date; // For subscriptions/classes
  schedulingPeriodEndsAt?: Date; // For subscriptions/classes
}

/**
 * Prisma transaction client type
 */
export type PrismaTransaction = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use"
>;
