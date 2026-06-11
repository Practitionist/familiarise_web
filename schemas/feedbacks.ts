import { z } from "zod";
import {
  MAX_SHORT_FIELD_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
} from "@/lib/validation/limits";

// #831 — every user-typed string carries a .max()
export const CreateFeedbackSchema = z.object({
  title: z.string().min(1, "Title is required").max(MAX_TITLE_LENGTH),
  description: z
    .string()
    .min(1, "Description is required")
    .max(MAX_TEXT_LENGTH),
  rating: z.number().int().min(1).max(5).optional(),
  category: z.string().max(MAX_SHORT_FIELD_LENGTH).optional(),
});

export const CreateReviewSchema = z.object({
  rating: z.number().int().min(1, "Rating is required").max(5),
  reviewDescription: z.string().max(MAX_TEXT_LENGTH).optional(),
  consultantProfileId: z.string().min(1, "Consultant profile ID is required"),
  consulteeProfileId: z.string().min(1, "Consultee profile ID is required"),
});
