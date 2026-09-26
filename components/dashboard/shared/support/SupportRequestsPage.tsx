"use client";

import type { ReactNode } from "react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { UrlTabs } from "@/components/dashboard/UrlTabs";
import { FeedbackPanel } from "./FeedbackPanel";
import { SupportHub } from "./SupportHub";

export interface SupportRequestsPageProps {
  /** The mounting dashboard's profile id (consultee or consultant). */
  profileId: string;
  /** `/dashboard/<tree>/<id>` — the page lives at `<basePath>/support`. */
  basePath: string;
  /** Suggested Help Center articles, rendered on the server (SuggestedArticles). */
  suggested: ReactNode;
}

/**
 * Support requests (#1527): your private conversations with the Familiarise
 * team, as URL tabs — Requests (Sessions · Platform) and Feedback. Articles
 * live only in the public Help Center; this page links a few beside the
 * request entry points. The old `help` route and `?tab=help` go to `/support`.
 */
export function SupportRequestsPage({
  profileId,
  basePath,
  suggested,
}: Readonly<SupportRequestsPageProps>) {
  return (
    <DashboardErrorBoundary>
      <PageHeader
        title="Support requests"
        description="Your conversations with the Familiarise team — about a session or the platform."
      />
      <UrlTabs
        tabs={[
          {
            value: "requests",
            label: "Requests",
            content: (
              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
                <SupportHub
                  profileId={profileId}
                  appointmentsHrefBase={`${basePath}/appointments`}
                  feedbackHref={`${basePath}/support?tab=feedback`}
                />
                <aside>{suggested}</aside>
              </div>
            ),
          },
          {
            value: "feedback",
            label: "Feedback",
            content: <FeedbackPanel profileId={profileId} />,
          },
        ]}
      />
    </DashboardErrorBoundary>
  );
}
