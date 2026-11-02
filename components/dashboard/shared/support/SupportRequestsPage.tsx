"use client";

import type { ReactNode } from "react";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { SupportHub } from "./SupportHub";
import { Button } from "@/components/ui/button";
import { PlatformSupportSheet } from "@/components/support/PlatformSupportSheet";
import { caseKeyOf } from "@/lib/support/case-key";
import { supportRequestHref } from "@/lib/novu/resolve-href";

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
        title="Your support cases"
        headingLevel={2}
        description="Track conversations with the Familiarise team about an appointment or your account."
      />
      <div className="space-y-6">
        <SupportHub
          requestsBase={`${basePath}/support/requests`}
          appointmentsHref={`${basePath}/appointments`}
        />
        <details className="border-t border-border pt-5">
          <summary className="cursor-pointer text-sm font-medium">
            Find an answer
          </summary>
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                Follow guided steps or browse answers to common questions.
              </p>
              <PlatformSupportSheet
                requestHref={(id) =>
                  supportRequestHref(caseKeyOf({ kind: "case", id }))
                }
                trigger={<Button variant="outline">Guided help</Button>}
              />
            </div>
            {suggested}
          </div>
        </details>
      </div>
    </>
  );
}
