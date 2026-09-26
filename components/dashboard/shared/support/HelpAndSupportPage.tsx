"use client";

import type { ReactNode } from "react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { UrlTabs } from "@/components/dashboard/UrlTabs";
import { FeedbackPanel } from "./FeedbackPanel";
import { SupportHub } from "./SupportHub";

export interface HelpAndSupportPageProps {
  /** The mounting dashboard's profile id (consultee or consultant). */
  profileId: string;
  /** `/dashboard/<tree>/<id>` — the page lives at `<basePath>/support`. */
  basePath: string;
  /** The Help center tab body, rendered on the server (HelpCenterPanel). */
  helpCenter: ReactNode;
}

/**
 * Help & support (#1527 Q2): one destination with URL tabs — Requests (the
 * support hub: Sessions · Platform), Feedback, and the audience-filtered Help
 * center. The old `feedback` and `help` routes 308 into `?tab=`.
 */
export function HelpAndSupportPage({
  profileId,
  basePath,
  helpCenter,
}: Readonly<HelpAndSupportPageProps>) {
  const supportHref = `${basePath}/support`;
  return (
    <DashboardErrorBoundary>
      <PageHeader
        title="Help & support"
        description="Get help with a session or the platform, tell us what you think, or find an answer."
      />
      <UrlTabs
        tabs={[
          {
            value: "requests",
            label: "Requests",
            content: (
              <SupportHub
                profileId={profileId}
                appointmentsHrefBase={`${basePath}/appointments`}
                feedbackHref={`${supportHref}?tab=feedback`}
                helpHref={`${supportHref}?tab=help`}
              />
            ),
          },
          {
            value: "feedback",
            label: "Feedback",
            content: <FeedbackPanel profileId={profileId} />,
          },
          { value: "help", label: "Help center", content: helpCenter },
        ]}
      />
    </DashboardErrorBoundary>
  );
}
