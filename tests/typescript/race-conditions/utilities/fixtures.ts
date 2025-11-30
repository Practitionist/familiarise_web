/**
 * Test Data Fixtures for Race Condition Test Suite
 * Generates realistic test data for consultants, users, and time slots
 */

import type { TestSlot, TestConsultant, TestUser } from "./types";

/**
 * Generate a future time slot for testing
 * @param daysAhead - Number of days in the future (default 7)
 * @param hour - Hour of the day (0-23, default 10)
 * @param minute - Minute of the hour (0-59, default 30)
 * @returns Test slot with start and end times
 */
export function generateTestSlot(
  daysAhead: number = 7,
  hour: number = 10,
  minute: number = 30,
): TestSlot {
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(now.getDate() + daysAhead);
  startDate.setHours(hour, minute, 0, 0);

  const endDate = new Date(startDate);
  endDate.setMinutes(endDate.getMinutes() + 30); // 30-minute slot

  return {
    start: startDate.toISOString(),
    end: endDate.toISOString(),
  };
}

/**
 * Generate multiple test slots with different times
 * @param count - Number of slots to generate
 * @returns Array of test slots
 */
export function generateMultipleTestSlots(count: number): TestSlot[] {
  const slots: TestSlot[] = [];
  for (let i = 0; i < count; i++) {
    const hour = 10 + Math.floor(i / 2); // Every 2 slots = 1 hour
    const minute = (i % 2) * 30; // 0 or 30 minutes
    slots.push(generateTestSlot(7, hour, minute));
  }
  return slots;
}

/**
 * Generate test consultant ID
 * @param index - Optional index for multiple consultants
 * @returns Consultant ID string
 */
export function generateConsultantId(index?: number): string {
  if (index !== undefined) {
    return `test-consultant-${String(index).padStart(3, "0")}`;
  }
  return "test-consultant-123";
}

/**
 * Generate test consultant object
 * @param index - Optional index for multiple consultants
 * @returns Test consultant object
 */
export function generateTestConsultant(index?: number): TestConsultant {
  const id = generateConsultantId(index);
  return {
    id,
    name: `Test Consultant ${index || 123}`,
    profileId: `profile-${id}`,
  };
}

/**
 * Generate test user ID
 * @param index - User index number
 * @returns User ID string
 */
export function generateUserId(index: number): string {
  return `test-user-${String(index).padStart(3, "0")}`;
}

/**
 * Generate test user object
 * @param index - User index number
 * @returns Test user object
 */
export function generateTestUser(index: number): TestUser {
  const id = generateUserId(index);
  return {
    id,
    name: `Test User ${index}`,
    email: `test.user${index}@example.com`,
  };
}

/**
 * Generate multiple test users
 * @param count - Number of users to generate
 * @returns Array of test users
 */
export function generateMultipleTestUsers(count: number): TestUser[] {
  return Array.from({ length: count }, (_, i) => generateTestUser(i + 1));
}

/**
 * Generate a specific time slot for the original bug reproduction test
 * This matches the actual bug report: "28 Oct 10:30 PM"
 * @returns Test slot matching the original bug
 */
export function generateOriginalBugSlot(): TestSlot {
  const startDate = new Date("2026-10-28T22:30:00.000Z"); // 10:30 PM UTC
  const endDate = new Date(startDate);
  endDate.setMinutes(endDate.getMinutes() + 30);

  return {
    start: startDate.toISOString(),
    end: endDate.toISOString(),
  };
}

/**
 * Generate random delay for staggered test execution
 * @param maxMs - Maximum delay in milliseconds
 * @returns Random delay in milliseconds
 */
export function generateRandomDelay(maxMs: number = 1000): number {
  return Math.floor(Math.random() * maxMs);
}

/**
 * Generate test consultation plan ID
 * @returns Consultation plan ID string
 */
export function generateConsultationPlanId(): string {
  return "test-consultation-plan-123";
}

/**
 * Generate test slot availability weekly ID
 * @returns Slot availability ID string
 */
export function generateSlotAvailabilityWeeklyId(): string {
  return "test-slot-availability-weekly-123";
}
