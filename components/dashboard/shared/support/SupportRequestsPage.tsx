"use client";

import type { ReactNode } from "react";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { SupportHub } from "./SupportHub";

export interface SupportRequestsPageProps {
  /** `/dashboard/<tree>/<id>` — the page lives at `<basePath>/support`. */
  basePath: string;
  /** Suggested Help Center articles, rendered on the server (SuggestedArticles). */
  suggested: ReactNode;
}

/** A single personal inbox; evidence, reporting and feedback have separate pages. */
export function SupportRequestsPage({
  basePath,
  suggested,
}: Readonly<SupportRequestsPageProps>) {
  return (
    <>
      <PageHeader
        title="Support requests"
        description="Your conversations with the Familiarise team — about a session or the platform."
      />
      <div className="space-y-6">
        <SupportHub
          requestsBase={`${basePath}/support/requests`}
          appointmentsHref={`${basePath}/appointments`}
        />
        <details className="rounded-lg border border-border p-4">
          <summary className="cursor-pointer text-sm font-medium">
            Helpful articles
          </summary>
          <div className="mt-4">{suggested}</div>
        </details>
      </div>
    </>
  );
}
