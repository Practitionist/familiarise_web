"use client";

/**
 * Writing a review from the CONSULTANT's profile, which is where the
 * review lives and where you read the others.
 *
 * A client island on purpose. The expert profile is statically cached (ISR plus
 * `unstable_cache` tags) and that is what makes explore fast; rendering a
 * per-user answer server-side would either force the page dynamic or risk one
 * viewer's eligibility landing in a shared cache entry. This asks at runtime
 * and renders nothing until it has an answer.
 */

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth-client";
import { throwSupportError } from "@/lib/support/error-copy";
import { RatingCauseSchema } from "@/schemas/enums";
import { ReviewComposer } from "./ReviewComposer";

const ReviewableSessionsResponseSchema = z.object({
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
type ReviewableSession = z.infer<
  typeof ReviewableSessionsResponseSchema
>["data"][number];

export function ProfileReviewComposer({
  consultantProfileId,
  consultantName,
}: Readonly<{ consultantProfileId: string; consultantName: string | null }>) {
  const queryKey = ["reviewable-for-consultant", consultantProfileId] as const;
  const { data: authSession, isPending: sessionPending } = useSession();

  const { data, isError, isLoading, refetch } = useQuery({
    queryKey,
    // Signed-out visitors are the common case on a public profile: never ask.
    enabled: !!authSession?.user?.id && !sessionPending,
    // A 401 from an expired cookie is still an answer ("nothing to offer").
    retry: false,
    queryFn: async (): Promise<ReviewableSession[]> => {
      const res = await fetch(
        `/api/user/reviews/reviewable-sessions?consultantProfileId=${encodeURIComponent(consultantProfileId)}`,
      );
      if (res.status === 401) return [];
      if (!res.ok) await throwSupportError(res, "review eligibility");
      return ReviewableSessionsResponseSchema.parse(await res.json()).data;
    },
  });

  // A failed check is NOT "you may not review". Rendering nothing for both is
  // the mistake the Platform tab made once — a load failure shown as an empty
  // state.
  if (isError) {
    return (
      <div className="mb-6 rounded-xl border border-dashed border-border p-4">
        <p className="text-sm text-muted-foreground">
          Couldn&apos;t check whether you can review this expert.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (isLoading || !data?.length) return null;

  // Most recent qualifying session — the provenance the write records.
  const session = data[0];

  // A dashed, muted surface with a rule under it: a form the viewer fills in,
  // sitting beside the review cards rather than above them in any hierarchy.
  return (
    <div className="mb-6 border-b border-border pb-6">
      <div className="rounded-xl border border-dashed border-border bg-muted/30 p-4">
        <ReviewComposer
          appointmentId={session.appointmentId}
          consultantName={consultantName ?? session.consultantName}
          contextLine={session.title}
          existing={session.existingReview}
          invalidateKeys={[queryKey]}
        />
      </div>
    </div>
  );
}
