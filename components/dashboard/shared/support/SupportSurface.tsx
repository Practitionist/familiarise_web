"use client";

/**
 * The one Support surface, shared by the consultant and consultee dashboards.
 *
 * Before this, the two roles had asymmetric and incomplete halves of the same
 * idea: consultees got `/feedback` (labelled "Support" in the nav, with a
 * hand-rolled two-button switcher) and no help content at all; consultants got
 * a static FAQ at `/help` reachable only from the avatar dropdown, and no way
 * to raise a ticket or leave feedback from their dashboard.
 *
 * Both now get the same three tabs in the same nav position. The panels are
 * role-agnostic because the endpoints behind them are: `/api/user/feedbacks`
 * and `/api/user/support-tickets` both key off `session.user.id`, not off a
 * consultee profile.
 *
 * Caveat worth knowing: ticket-to-appointment linkage in
 * `/api/user/support-tickets` matches on `requestedBy.userId`, i.e. the
 * booking side. A consultant raising a ticket about a session they delivered
 * gets an unlinked ticket. Per-appointment support for the delivering side
 * already exists via the #1022 thread on the appointment detail page.
 */

import { useQuery } from "@tanstack/react-query";

import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { UrlTabs, type UrlTab } from "@/components/dashboard/UrlTabs";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { staticQueries } from "@/hooks/useConsultantPrefetchDashboard";

import { FeedbackPanel } from "./FeedbackPanel";
import { HelpPanel } from "./HelpPanel";

function HelpTabContent() {
  const { data: faqData, isLoading, error } = useQuery(staticQueries.help);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading help…</p>;
  }
  if (error) {
    return (
      <p className="text-sm text-red-600 dark:text-red-400">
        {error.message || "Failed to load help content."}
      </p>
    );
  }
  return <HelpPanel faqs={faqData || []} />;
}

export function SupportSurface({ profileId }: { profileId: string }) {
  const tabs: UrlTab[] = [
    {
      value: "requests",
      label: "My requests",
      content: <FeedbackPanel profileId={profileId} view="requests" />,
    },
    {
      value: "feedback",
      label: "Feedback",
      content: <FeedbackPanel profileId={profileId} view="feedback" />,
    },
    { value: "help", label: "Help", content: <HelpTabContent /> },
  ];

  return (
    <DashboardErrorBoundary>
      <DashboardHeader
        title="Support"
        subtitle="Raise a request, share feedback, or find an answer."
      />
      <div className="p-4 sm:p-6 lg:p-8">
        <UrlTabs tabs={tabs} />
      </div>
    </DashboardErrorBoundary>
  );
}
