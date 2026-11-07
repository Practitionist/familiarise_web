import "server-only";

import { Suspense } from "react";
import { HydrationBoundary } from "@tanstack/react-query";

import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { Skeleton } from "@/components/ui/skeleton";
import { readDigitalProductLibrary } from "@/lib/data/digital-product-library";
import { readDocumentLibrary } from "@/lib/data/document-library";
import { readRecordingLibrary } from "@/lib/data/recording-library";
import {
  resolveLibraryTab,
  type LibraryTab,
} from "@/lib/dashboard/library-tabs";
import { libraryKeys } from "@/lib/documents/query-keys";
import {
  parseLibraryQuery,
  type LibraryScope,
} from "@/lib/library/library-query";
import { seedLibraryPage } from "@/lib/library/library-seed";
import { getViewerZone } from "@/lib/time/viewer-zone-server";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";

import { DigitalProductLibrary } from "./DigitalProductLibrary";
import { LibraryTabNav } from "./LibraryTabNav";
import { OrgLibrary } from "./OrgLibrary";
import { PersonalLibrary } from "./PersonalLibrary";

type SearchParams = Record<string, string | string[] | undefined>;

/** Whose Library this is; the page has already checked the viewer may see it. */
export type LibraryHolder =
  | {
      kind: "personal";
      /** The user whose purchases are listed; null lists none. */
      buyerId: string | null;
      /** The learner side whose attended sessions are listed. */
      learner: {
        consulteeId: string;
        /** The session user, who reads as the profile's owner. */
        readerId: string;
        /** An inspecting operator's list is read by the route, not seeded. */
        skipSeed: boolean;
      } | null;
    }
  | {
      kind: "org";
      orgId: string;
      viewerId: string;
      /** Null when the requested scope is refused; the client shows Mine. */
      scope: LibraryScope | null;
      canSeeEveryone: boolean;
    };

const DESCRIPTION: Record<
  LibraryHolder["kind"],
  Partial<Record<LibraryTab, string>>
> = {
  personal: {
    purchases:
      "Files you bought or claimed. Downloads never expire, and you always get the latest version.",
    recordings:
      "Your sessions' recordings, by booking. A session your run missed shows a catch-up from another run.",
    documents:
      "Files you shared with your experts, their replies, and plan materials. Open a booking to upload or ask for changes.",
  },
  org: {
    recordings:
      "Recordings of this organization's sessions. Everyone shows counts, never titles.",
    documents:
      "Files shared in this organization's 1:1 bookings. Everyone shows counts, never file names.",
  },
};

/** The active tab's list; only that tab's data is read on the server. */
async function LibraryPanel({
  owner,
  tab,
  searchParams,
}: Readonly<{
  owner: LibraryHolder;
  tab: LibraryTab;
  searchParams: SearchParams;
}>) {
  if (tab === "purchases") {
    const products =
      owner.kind === "personal" && owner.buyerId
        ? await readDigitalProductLibrary(owner.buyerId)
        : [];
    return <DigitalProductLibrary products={products} />;
  }
  const read = tab === "documents" ? readDocumentLibrary : readRecordingLibrary;
  if (owner.kind === "org") {
    const scope = owner.scope ?? "mine";
    const [seed, zone] = await Promise.all([
      seedLibraryPage({
        name: `${tab}:org`,
        queryKey: libraryKeys.org(owner.orgId, tab, scope),
        fixedParams: { scope },
        searchParams,
        skip: owner.scope === null,
        read: () =>
          read({
            userId: owner.viewerId,
            owner: {
              kind: "org",
              orgId: owner.orgId,
              everyone: scope === "everyone",
            },
            query: parseLibraryQuery(() => null),
          }),
      }),
      getViewerZone(),
    ]);
    return (
      <DisplayZoneProvider zone={zone.zone}>
        <HydrationBoundary state={seed}>
          <OrgLibrary
            key={tab}
            orgId={owner.orgId}
            artifact={tab}
            canSeeEveryone={owner.canSeeEveryone}
          />
        </HydrationBoundary>
      </DisplayZoneProvider>
    );
  }
  const learner = owner.learner;
  if (!learner) return null;
  const [seed, zone] = await Promise.all([
    seedLibraryPage({
      name: `${tab}:learner`,
      queryKey: libraryKeys.personal(tab, "consultee", learner.consulteeId),
      searchParams,
      skip: learner.skipSeed,
      read: () =>
        read({
          userId: learner.readerId,
          owner: { kind: "personal", side: "learner" },
          query: parseLibraryQuery(() => null),
        }),
    }),
    getViewerZone(),
  ]);
  return (
    <DisplayZoneProvider zone={zone.zone}>
      <HydrationBoundary state={seed}>
        <PersonalLibrary
          key={tab}
          tree="consultee"
          profileId={learner.consulteeId}
          artifact={tab}
        />
      </HydrationBoundary>
    </DisplayZoneProvider>
  );
}

/** Same rows the list shows while its own request loads, so the swap is flat. */
function LibraryPanelFallback() {
  return (
    <output aria-busy="true" className="block space-y-3">
      <span className="sr-only">Loading…</span>
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-20 rounded-xl" />
      ))}
    </output>
  );
}

/**
 * The one buyer Library for every role: URL tabs (`?tab=`) that navigate, so
 * the server renders and reads only the active tab. One tab hides the bar.
 * The header and tabs render without the panel's reads; the panel streams
 * behind a boundary keyed by tab so every tab switch shows the fallback. The
 * caller's access checks run before this renders, never inside the boundary.
 */
export function LibraryPage({
  title,
  basePath,
  tabs,
  owner,
  searchParams,
}: Readonly<{
  title: string;
  /** The Library route, e.g. `/dashboard/consultee/<id>/library`. */
  basePath: string;
  tabs: readonly [LibraryTab, ...LibraryTab[]];
  owner: LibraryHolder;
  searchParams: SearchParams;
}>) {
  const active = resolveLibraryTab(searchParams.tab, tabs);
  return (
    <>
      <DashboardHeader
        title={title}
        description={DESCRIPTION[owner.kind][active]}
      />
      <DashboardContent>
        {tabs.length > 1 && (
          <LibraryTabNav
            title={title}
            basePath={basePath}
            tabs={tabs}
            active={active}
            carryScope={owner.kind === "org"}
          />
        )}
        <Suspense key={active} fallback={<LibraryPanelFallback />}>
          <LibraryPanel
            owner={owner}
            tab={active}
            searchParams={searchParams}
          />
        </Suspense>
      </DashboardContent>
    </>
  );
}
