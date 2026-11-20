"use client";

/**
 * The review form for one booking, on its detail page. It renders only when the
 * review route accepts a review of this session, and never depends on the
 * expert's public profile being live.
 */

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { SESSION_REVIEW_ANCHOR } from "@/lib/dashboard/action-items";
import { ReviewComposer } from "./ReviewComposer";
import { fetchReviewableSessions } from "./reviewable-sessions";

export function SessionReviewCard({
  appointmentId,
  consultantName,
}: Readonly<{ appointmentId: string; consultantName: string | null }>) {
  const queryKey = ["reviewable-session", appointmentId] as const;
  const { data, isError, isLoading, refetch } = useQuery({
    queryKey,
    retry: false,
    queryFn: () => fetchReviewableSessions({ appointmentId }),
  });
  const session = data?.[0] ?? null;

  // The form arrives after the page, so the browser's own jump to #review has already passed.
  const anchorRef = useRef<HTMLElement>(null);
  const hasForm = session !== null;
  useEffect(() => {
    if (hasForm && window.location.hash === `#${SESSION_REVIEW_ANCHOR}`) {
      anchorRef.current?.scrollIntoView({ block: "start" });
    }
  }, [hasForm]);

  if (isError) {
    return (
      <div className="rounded-2xl border border-dashed border-border px-5 py-4">
        <p className="text-sm text-muted-foreground">
          Couldn&apos;t check whether you can review this session.
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
  if (isLoading || !session) return null;

  return (
    <section
      id={SESSION_REVIEW_ANCHOR}
      ref={anchorRef}
      className="scroll-mt-24 rounded-2xl border border-border bg-card px-5 py-4 shadow-sm"
    >
      <ReviewComposer
        appointmentId={session.appointmentId}
        consultantName={consultantName ?? session.consultantName}
        contextLine={session.title}
        existing={session.existingReview}
        profileIsPublic={session.profileIsPublic}
        // Home's prompt and the profile's form read the same eligibility.
        invalidateKeys={[
          queryKey,
          ["reviewable-sessions"],
          ["reviewable-for-consultant"],
        ]}
      />
    </section>
  );
}
