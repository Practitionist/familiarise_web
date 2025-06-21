import { z } from "zod";

/**
 * Shared validation schema for experience field
 * Used across forms, APIs, and data validation
 */
export const experienceValidation = z
  .number()
  .min(0, "Experience cannot be negative")
  .max(100, "Experience cannot exceed 100 years")
  .optional();

export type Experience = z.infer<typeof experienceValidation>;