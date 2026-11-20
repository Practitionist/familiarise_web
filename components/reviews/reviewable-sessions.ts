import { z } from "zod";
import { throwSupportError } from "@/lib/support/error-copy";
import { RatingCauseSchema } from "@/schemas/enums";

/** The client's view of `GET /api/user/reviews/reviewable-sessions`. */
export const ReviewableSessionsResponseSchema = z.object({
  data: z.array(
    z.object({
      appointmentId: z.string(),
      consultantName: z.string().nullable(),
      title: z.string(),
      heldAt: z.string().nullable(),
      existingReview: z
        .object({
          id: z.string(),
          rating: z.number(),
          reviewDescription: z.string().nullable(),
          ratingCause: RatingCauseSchema.nullable(),
        })
        .nullable(),
    }),
  ),
});
export type ReviewableSessionRow = z.infer<
  typeof ReviewableSessionsResponseSchema
>["data"][number];

/** Sessions the signed-in learner may review; a 401 means there is nothing to offer. */
export async function fetchReviewableSessions(
  filter: { consultantProfileId: string } | { appointmentId: string },
): Promise<ReviewableSessionRow[]> {
  const res = await fetch(
    `/api/user/reviews/reviewable-sessions?${new URLSearchParams(filter).toString()}`,
  );
  if (res.status === 401) return [];
  if (!res.ok) await throwSupportError(res, "review eligibility");
  return ReviewableSessionsResponseSchema.parse(await res.json()).data;
}
