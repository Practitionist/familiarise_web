import { z } from "zod";

export const CreateFeedbackSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().min(1, "Description is required"),
  rating: z.number().int().min(1).max(5).optional(),
  category: z.string().optional(),
});

export const CreateReviewSchema = z.object({
  rating: z.number().int().min(1, "Rating is required").max(5),
  reviewDescription: z.string().optional(),
  consultantProfileId: z.string().min(1, "Consultant profile ID is required"),
  consulteeProfileId: z.string().min(1, "Consultee profile ID is required"),
});

export type CreateFeedbackInput = z.infer<typeof CreateFeedbackSchema>;
export type CreateReviewInput = z.infer<typeof CreateReviewSchema>;
