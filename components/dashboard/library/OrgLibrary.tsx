"use client";

/**
 * Org Library › Session documents | Session recordings, scoped Mine · Everyone
 * as URL tabs (`?scope=`). Mine is the member's own bookings; Everyone is the
 * `operations.read` oversight view, counts only, re-checked by the route.
 */

import { UrlTabs } from "@/components/dashboard/UrlTabs";
import { LibraryBrowser } from "@/components/dashboard/library/LibraryBrowser";
import { libraryKeys } from "@/lib/documents/query-keys";
import {
  documentSourcesFor,
  type LibraryScope,
} from "@/lib/library/library-query";

type Artifact = "documents" | "recordings";

const EMPTY: Record<Artifact, Record<LibraryScope, string>> = {
  documents: {
    mine: "Files from the bookings you attend or deliver here land in this list.",
    everyone:
      "No documents have been uploaded on this organization's bookings.",
  },
  recordings: {
    mine: "Recordings of the sessions you attend or deliver here land in this list.",
    everyone: "No sessions under this organization have been recorded yet.",
  },
};

export function OrgLibrary({
  orgId,
  artifact,
  canSeeEveryone,
}: Readonly<{ orgId: string; artifact: Artifact; canSeeEveryone: boolean }>) {
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
      side="mixed"
      sources={artifact === "documents" ? documentSourcesFor(scope) : undefined}
      personLabel="Person"
      emptyDescription={EMPTY[artifact][scope]}
    />
  );

  return canSeeEveryone ? (
    <UrlTabs
      paramName="scope"
      tabs={[
        { value: "mine", label: "Mine", content: browser("mine") },
        { value: "everyone", label: "Everyone", content: browser("everyone") },
      ]}
    />
  ) : (
    browser("mine")
  );
}
