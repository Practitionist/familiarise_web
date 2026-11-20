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
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth-client";
import { ReviewComposer } from "./ReviewComposer";
import { fetchReviewableSessions } from "./reviewable-sessions";

export function ProfileReviewComposer({
  consultantProfileId,
  consultantName,
}: Readonly<{ consultantProfileId: string; consultantName: string | null }>) {
  const { data: authSession, isPending: sessionPending } = useSession();
  const viewerId = authSession?.user?.id ?? null;
  // Keyed by viewer so a sign-out and sign-in on one tab never reuses another account's answer.
  const queryKey = [
    "reviewable-for-consultant",
    consultantProfileId,
    viewerId,
  ] as const;

  const { data, isError, isLoading, refetch } = useQuery({
    queryKey,
    // Signed-out visitors are the common case on a public profile: never ask.
    enabled: !!viewerId && !sessionPending,
    // A 401 from an expired cookie is still an answer ("nothing to offer").
    retry: false,
    queryFn: () => fetchReviewableSessions({ consultantProfileId }),
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
          profileIsPublic={session.profileIsPublic}
          invalidateKeys={[queryKey]}
        />
      </div>
    </div>
  );
}
