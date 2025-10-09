/**
 * Zod Validation Schemas for Slot Allocation API Routes
 *
 * PURPOSE: Type-safe, declarative validation for all event booking endpoints
 *
 * WHY ZOD:
 * - Type inference: Automatic TypeScript types from schemas
 * - Composable: Define once, reuse everywhere
 * - Better DX: Declarative vs imperative validation
 * - Industry standard: Used by Vercel, tRPC, Remix, etc.
 * - Rich errors: Detailed validation messages out of the box
 *
 * VALIDATION LAYERS:
 * 1. Zod schemas (this file) - Validates data types and formats
 * 2. SlotValidationService - Validates business rules (conflicts, availability)
 * 3. SlotAllocationService - Executes allocation logic
 */

import { z } from "zod";

/**
 * ALLOCATION REQUEST SCHEMA
 *
 * Used by: All allocate endpoints (consultations, subscriptions, webinars, classes)
 *
 * Validates:
 * - isAuto: boolean flag for auto vs manual allocation
 * - slots: array of ISO datetime strings (required for manual allocation)
 * - useRequestedSlots: boolean flag to use pre-created appointments
 *
 * Business rule: Manual allocation requires slots array unless using requested slots
 */
export const allocationRequestSchema = z
  .object({
    isAuto: z.boolean({
      required_error: "'isAuto' is required",
      invalid_type_error: "'isAuto' must be a boolean (true/false)",
    }),

    useRequestedSlots: z
      .boolean({
        invalid_type_error: "'useRequestedSlots' must be a boolean",
      })
      .optional(),

    slots: z
      .array(
        z.string().datetime({
          message:
            "Each slot must be a valid ISO 8601 datetime string (e.g., '2025-01-15T10:00:00Z')",
        }),
      )
      .optional(),
  })
  .refine(
    (data) => {
      // Auto allocation: no slots needed
      if (data.isAuto) return true;

      // Using requested slots: no manual slots needed
      if (data.useRequestedSlots) return true;

      // Manual allocation: slots array is required
      return data.slots && data.slots.length > 0;
    },
    {
      message:
        "Manual allocation requires 'slots' array with at least one time slot",
      path: ["slots"],
    },
  );

/**
 * VALIDATION REQUEST SCHEMA
 *
 * Used by: All validate endpoints (consultations, subscriptions, webinars, classes)
 *
 * Validates:
 * - slots: array of ISO datetime strings (required, non-empty)
 *
 * This is simpler than allocation since validation always requires slots.
 */
export const validationRequestSchema = z.object({
  slots: z
    .array(
      z.string().datetime({
        message:
          "Each slot must be a valid ISO 8601 datetime string (e.g., '2025-01-15T10:00:00Z')",
      }),
    )
    .min(1, {
      message: "'slots' array must contain at least one time slot to validate",
    }),
});

/**
 * EVENT ID SCHEMA
 *
 * Used by: All API routes for validating URL path parameters
 *
 * Validates:
 * - ID is a valid UUID format (v4)
 *
 * UUID format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 * Example: "123e4567-e89b-12d3-a456-426614174000"
 */
export const eventIdSchema = z.string().uuid({
  message: "Event ID must be a valid UUID format",
});

/**
 * PAGINATION SCHEMA
 *
 * Used by: List endpoints (future feature)
 *
 * Validates:
 * - page: positive integer (default: 1)
 * - limit: integer between 1-100 (default: 20)
 *
 * This is prepared for future pagination features.
 */
export const paginationSchema = z.object({
  page: z.coerce
    .number()
    .int()
    .positive({ message: "'page' must be a positive integer" })
    .default(1),

  limit: z.coerce
    .number()
    .int()
    .min(1, { message: "'limit' must be at least 1" })
    .max(100, { message: "'limit' cannot exceed 100" })
    .default(20),
});

/**
 * TYPESCRIPT TYPE EXPORTS
 *
 * These types are automatically inferred from the Zod schemas above.
 * Use these instead of manually defining TypeScript interfaces.
 *
 * BENEFITS:
 * - Single source of truth (schema = type)
 * - Schemas and types always stay in sync
 * - No duplicate type definitions
 */
export type AllocationRequest = z.infer<typeof allocationRequestSchema>;
export type ValidationRequest = z.infer<typeof validationRequestSchema>;
export type EventId = z.infer<typeof eventIdSchema>;
export type PaginationParams = z.infer<typeof paginationSchema>;

/**
 * HELPER: Parse and format Zod errors for API responses
 *
 * Converts Zod's detailed error structure into user-friendly messages.
 *
 * EXAMPLE:
 * Input: ZodError with 2 issues
 * Output: "slots: Each slot must be a valid ISO datetime; isAuto: Required field"
 */
export function formatZodError(error: z.ZodError): string {
  return error.errors
    .map((err) => {
      const path = err.path.join(".");
      return path ? `${path}: ${err.message}` : err.message;
    })
    .join("; ");
}

/**
 * HELPER: Safe parse with custom error handling
 *
 * Wraps Zod's parse() with try-catch and returns formatted error.
 * Use this in API routes for consistent error handling.
 *
 * RETURNS:
 * - { success: true, data: T } on valid data
 * - { success: false, error: string } on validation failure
 */
export function safeParse<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
): { success: true; data: T } | { success: false; error: string } {
  try {
    const parsed = schema.parse(data);
    return { success: true, data: parsed };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: formatZodError(error) };
    }
    return { success: false, error: "Invalid input data" };
  }
}
