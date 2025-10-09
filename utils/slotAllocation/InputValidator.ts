/**
 * Input Validation Layer
 *
 * PURPOSE: Catch malformed data before it reaches business logic
 *
 * LAYER ARCHITECTURE:
 * 1. InputValidator (this file) - Validates data types and formats
 * 2. SlotValidationService - Validates business rules
 * 3. SlotAllocationService - Executes allocation logic
 *
 * WHY SEPARATE INPUT VALIDATION:
 * - Prevents TypeErrors and runtime crashes from bad data
 * - Provides clear, user-friendly error messages
 * - Centralizes validation rules for consistency
 * - Makes business logic cleaner (assumes valid input types)
 *
 * EXAMPLE:
 * Bad: slots: ["2025-01-01", "not-a-date", null, 12345]
 * This file catches: non-string, null, invalid date format
 * SlotValidationService catches: past dates, conflicts, availability
 */

export class InputValidator {
  /**
   * Validate allocation request body from API routes
   *
   * CHECKS:
   * - isAuto is boolean
   * - slots array exists for manual allocation
   * - slots array is not empty
   * - each slot is valid ISO date string
   *
   * USED BY:
   * - app/api/events/consultations/[id]/allocate/route.ts
   * - app/api/events/subscriptions/[id]/allocate/route.ts
   * - app/api/events/webinars/[id]/allocate/route.ts
   * - app/api/events/classes/[id]/allocate/route.ts
   */
  static validateAllocationRequest(body: any): void {
    // Validate isAuto flag
    if (typeof body.isAuto !== "boolean") {
      throw new Error(
        `'isAuto' must be a boolean (true/false), but received: ${typeof body.isAuto}`,
      );
    }

    // For manual allocation, validate slots array
    if (!body.isAuto && body.useRequestedSlots !== true) {
      if (!Array.isArray(body.slots)) {
        throw new Error(
          `'slots' must be an array for manual allocation, but received: ${typeof body.slots}`,
        );
      }

      if (body.slots.length === 0) {
        throw new Error(
          "'slots' array cannot be empty for manual allocation. Please select at least one time slot.",
        );
      }

      // Validate each slot is a valid ISO date string
      for (let i = 0; i < body.slots.length; i++) {
        const slot = body.slots[i];

        if (typeof slot !== "string") {
          throw new Error(
            `Slot at index ${i} must be a string (ISO date), but received: ${typeof slot}`,
          );
        }

        const date = new Date(slot);
        if (isNaN(date.getTime())) {
          throw new Error(
            `Slot at index ${i} has invalid date format: "${slot}". Expected ISO 8601 format (e.g., "2025-01-15T10:00:00Z")`,
          );
        }
      }
    }

    // Validate useRequestedSlots if present
    if (body.useRequestedSlots !== undefined && typeof body.useRequestedSlots !== "boolean") {
      throw new Error(
        `'useRequestedSlots' must be a boolean if provided, but received: ${typeof body.useRequestedSlots}`,
      );
    }
  }

  /**
   * Validate slots array for validation requests
   *
   * USED BY:
   * - app/api/events/consultations/[id]/validate/route.ts
   * - app/api/events/subscriptions/[id]/validate/route.ts
   * - app/api/events/webinars/[id]/validate/route.ts
   * - app/api/events/classes/[id]/validate/route.ts
   */
  static validateSlotsArray(body: any): void {
    if (!body.slots) {
      throw new Error(
        "'slots' field is required but was not provided in the request body",
      );
    }

    if (!Array.isArray(body.slots)) {
      throw new Error(
        `'slots' must be an array, but received: ${typeof body.slots}`,
      );
    }

    if (body.slots.length === 0) {
      throw new Error(
        "'slots' array cannot be empty. Please provide at least one time slot to validate.",
      );
    }

    // Validate each slot
    for (let i = 0; i < body.slots.length; i++) {
      const slot = body.slots[i];

      if (typeof slot !== "string") {
        throw new Error(
          `Slot at index ${i} must be a string (ISO date), but received: ${typeof slot}`,
        );
      }

      // Check if it's a valid date
      const date = new Date(slot);
      if (isNaN(date.getTime())) {
        throw new Error(
          `Slot at index ${i} has invalid date format: "${slot}". Expected ISO 8601 format (e.g., "2025-01-15T10:00:00Z")`,
        );
      }
    }
  }

  /**
   * Validate event ID parameter
   *
   * USED BY: All event API routes
   */
  static validateEventId(eventId: string | undefined, eventType: string): void {
    if (!eventId) {
      throw new Error(`${eventType} ID is required but was not provided`);
    }

    if (typeof eventId !== "string") {
      throw new Error(
        `${eventType} ID must be a string, but received: ${typeof eventId}`,
      );
    }

    if (eventId.trim().length === 0) {
      throw new Error(`${eventType} ID cannot be empty`);
    }

    // Basic UUID format validation (optional but recommended)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(eventId)) {
      throw new Error(
        `${eventType} ID has invalid format. Expected UUID format (e.g., "123e4567-e89b-12d3-a456-426614174000")`,
      );
    }
  }

  /**
   * Validate pagination parameters
   *
   * USED BY: List endpoints (future feature)
   */
  static validatePagination(query: any): void {
    if (query.page !== undefined) {
      const page = parseInt(query.page);
      if (isNaN(page) || page < 1) {
        throw new Error(
          `'page' must be a positive integer, but received: ${query.page}`,
        );
      }
    }

    if (query.limit !== undefined) {
      const limit = parseInt(query.limit);
      if (isNaN(limit) || limit < 1 || limit > 100) {
        throw new Error(
          `'limit' must be an integer between 1 and 100, but received: ${query.limit}`,
        );
      }
    }
  }

  /**
   * Sanitize user input to prevent injection attacks
   *
   * NOTE: This is a basic implementation. For production, consider using
   * a dedicated library like DOMPurify or validator.js
   */
  static sanitizeString(input: string): string {
    if (typeof input !== "string") {
      return "";
    }

    // Remove potentially dangerous characters
    // This is a basic example - expand based on your security requirements
    return input
      .trim()
      .replace(/[<>'"]/g, "") // Remove HTML/JS injection chars
      .slice(0, 1000); // Prevent extremely long strings
  }
}
