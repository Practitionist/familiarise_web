"use client";

/**
 * Org Library › Documents | Recordings (#1527): Mine · Everyone as URL tabs
 * (`?scope=`), mirroring Appointments. Mine is every member's own sessions;
 * Everyone is the `operations.read` oversight view, re-checked by the route.
 */

import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { UrlTabs } from "@/components/dashboard/UrlTabs";
import { LibraryBrowser } from "@/components/dashboard/library/LibraryBrowser";
import {
  documentSourcesFor,
  type LibraryScope,
} from "@/lib/library/library-query";

type Artifact = "documents" | "recordings";

const COPY: Record<
  Artifact,
  { title: string; description: string; empty: Record<LibraryScope, string> }
> = {
  documents: {
    title: "Documents",
    description:
      "Plan materials, your uploads and responses for this organization's sessions.",
    empty: {
      mine: "Files from the sessions you attend or deliver here land in this list.",
      everyone:
        "No documents have been uploaded on this organization's sessions.",
    },
  },
  recordings: {
    title: "Recordings",
    description: "Recordings of this organization's sessions.",
    empty: {
      mine: "Recordings of the sessions you attend or deliver here land in this list.",
      everyone: "No sessions under this organization have been recorded yet.",
    },
  },
};

export function OrgLibraryPage({
  orgId,
  artifact,
  canSeeEveryone,
}: Readonly<{ orgId: string; artifact: Artifact; canSeeEveryone: boolean }>) {
  const copy = COPY[artifact];
  const browser = (scope: LibraryScope) => (
    <LibraryBrowser
      artifact={artifact}
      endpoint={`/api/organizations/${orgId}/${artifact}`}
      fixedParams={{ scope }}
      queryKey={["org-library", orgId, artifact, scope]}
      sessionHref={(id) =>
        `/dashboard/organization/${orgId}/appointments/${id}`
      }
      sources={artifact === "documents" ? documentSourcesFor(scope) : undefined}
      emptyDescription={copy.empty[scope]}
    />
  );

  return (
    <>
      <DashboardHeader title={copy.title} description={copy.description} />
      <DashboardContent>
        {canSeeEveryone ? (
          <UrlTabs
            paramName="scope"
            tabs={[
              { value: "mine", label: "Mine", content: browser("mine") },
              {
                value: "everyone",
                label: "Everyone",
                content: browser("everyone"),
              },
            ]}
          />
        ) : (
          browser("mine")
        )}
      </DashboardContent>
    </>
  );
}
