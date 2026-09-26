"use client";

import { useQuery } from "@tanstack/react-query";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { Section } from "@/components/dashboard/Section";
import { staticQueries } from "@/hooks/useConsultantPrefetchDashboard";
import { HelpPanel } from "./HelpPanel";

/**
 * The consultant FAQ (questions.ts). #1527 Q2 — it covers expert topics the
 * public help centre does not (earning statuses, referral qualifying), so it
 * stays under the experts' Help center; learners no longer see it.
 */
export function ExpertFaqPanel() {
  const {
    data: faqs,
    isLoading,
    error,
    refetch,
  } = useQuery(staticQueries.help);
  let body: React.ReactNode;
  if (isLoading) {
    body = <p className="text-sm text-muted-foreground">Loading answers…</p>;
  } else if (error) {
    body = (
      <ErrorState
        variant="inline"
        title="Couldn't load the expert FAQ"
        onRetry={() => void refetch()}
      />
    );
  } else {
    body = <HelpPanel faqs={faqs || []} />;
  }
  return <Section title="More answers for experts">{body}</Section>;
}
