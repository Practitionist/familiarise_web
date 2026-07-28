"use client";

import { useQuery } from "@tanstack/react-query";

import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { staticQueries } from "@/hooks/useConsultantPrefetchDashboard";

import { FeedbackPanel } from "./FeedbackPanel";
import { HelpPanel } from "./HelpPanel";

/**
 * The three support surfaces as standalone pages.
 *
 * They were `UrlTabs` on a single Support page. Split because they are distinct
 * destinations rather than scopes of one thing — a ticket list, a feedback form
 * and an FAQ answer different questions and share no state — which is the same
 * rule ADR 19 used to turn `?role=` filters INTO tabs. The test is whether
 * something meaningfully different lives behind each entry, not whether tabs
 * are fewer clicks.
 *
 * The panels are unchanged and still role-agnostic: `/api/user/feedbacks` and
 * `/api/user/support-tickets` key off `session.user.id`, not off a profile, so
 * consultant, consultee and enterprise operator all mount the same components.
 */

function Shell({
  title,
  subtitle,
  children,
}: Readonly<{ title: string; subtitle: string; children: React.ReactNode }>) {
  return (
    <DashboardErrorBoundary>
      <DashboardHeader title={title} subtitle={subtitle} />
      <div className="p-4 sm:p-6 lg:p-8">{children}</div>
    </DashboardErrorBoundary>
  );
}

export function SupportRequestsPage({
  profileId,
}: Readonly<{ profileId: string }>) {
  return (
    <Shell
      title="Support requests"
      subtitle="Requests you've raised, and where each one has got to."
    >
      <FeedbackPanel profileId={profileId} view="requests" />
    </Shell>
  );
}

export function SupportFeedbackPage({
  profileId,
}: Readonly<{ profileId: string }>) {
  return (
    <Shell
      title="Feedback"
      subtitle="Tell us what's working and what isn't."
    >
      <FeedbackPanel profileId={profileId} view="feedback" />
    </Shell>
  );
}

export function SupportHelpPage() {
  const { data: faqs, isLoading, error } = useQuery(staticQueries.help);

  return (
    <Shell title="Help" subtitle="Answers to the questions we get most.">
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading help…</p>
      ) : error ? (
        <p className="text-sm text-red-600 dark:text-red-400">
          {error.message || "Failed to load help content."}
        </p>
      ) : (
        <HelpPanel faqs={faqs || []} />
      )}
    </Shell>
  );
}
