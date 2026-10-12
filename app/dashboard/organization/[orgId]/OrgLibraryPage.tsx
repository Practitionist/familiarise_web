"use client";

/**
 * Org Library › Documents | Recordings: Mine · Everyone as URL tabs
 * (`?scope=`). Mine is the member's own bookings; Everyone is the
 * `operations.read` oversight view, counts only, re-checked by the route.
 */

import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { UrlTabs } from "@/components/dashboard/UrlTabs";
import { LibraryBrowser } from "@/components/dashboard/library/LibraryBrowser";
import { libraryKeys } from "@/lib/documents/query-keys";
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
      "Files shared in this organization's 1:1 bookings. Everyone shows counts, never file names.",
    empty: {
      mine: "Files from the bookings you attend or deliver here land in this list.",
      everyone:
        "No documents have been uploaded on this organization's bookings.",
    },
  },
  recordings: {
    title: "Recordings",
    description:
      "Recordings of this organization's sessions. Everyone shows counts, never titles.",
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
      queryKey={libraryKeys.org(orgId, artifact, scope)}
      sessionHref={(id) =>
        scope === "everyone"
          ? `/dashboard/organization/${orgId}/appointments/${id}`
          : `/dashboard/organization/${orgId}/appointments/${id}/${artifact}`
      }
      bookingHref={(id) =>
        `/dashboard/organization/${orgId}/appointments/${id}`
      }
      sources={artifact === "documents" ? documentSourcesFor(scope) : undefined}
      personLabel="Person"
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
