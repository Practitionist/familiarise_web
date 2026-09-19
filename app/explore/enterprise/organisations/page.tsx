import { Building2, Layers } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";

import {
  DEFAULT_ORGANISATION_FILTERS,
  getOrganisationsMetadata,
  getOrganisationsPage,
} from "@/lib/data/explore-organisations";
import { withBuildTimeRetry } from "@/lib/data/fail-open";
import ExploreHero from "@/app/explore/components/ExploreHero";

import OrganisationsInteractiveContent, {
  OrganisationsGridSkeleton,
} from "./OrganisationsInteractiveContent";

// ISR, not force-dynamic. The directory reads no session and no searchParams
// (filtering is client-side in OrganisationsInteractiveContent), and it lists
// only `isPublic` ACTIVE orgs, so every visitor is entitled to the same HTML.
//
// force-dynamic made this uncacheable at the CDN (Next sends dynamic pages
// `private, no-store`), so every visit paid a cross-region DB round trip for a
// list that turns over on the order of days.
//
// This route IS prerendered during `next build` (#932): the reads run in the
// build environment and no longer degrade at all (#1119), so a transient pooler
// failure fails the build instead of baking an empty directory.
//
// 5 minutes: unlike the expert reads this one has no unstable_cache layer, so
// the interval is the only thing between visitors and the DB. Orgs going public
// purge this path on demand at the write sites.
export const revalidate = 300;

export const metadata: Metadata = {
  title: "Explore Organisations | Familiarise",
  description:
    "Discover expert networks, consulting agencies, and learning institutions on Familiarise. Browse their curated experts and programs.",
};

async function OrganisationsDirectory() {
  // Both reads throw on a transient pooler timeout (cross-region cold connect,
  // #932). They used to degrade, which was safe while this route was dynamic and
  // is not now that it is ISR — a degraded directory would be cached and replayed
  // to everyone (#1119).
  const [meta, firstPage] = await Promise.all([
    withBuildTimeRetry(getOrganisationsMetadata),
    withBuildTimeRetry(() => getOrganisationsPage(DEFAULT_ORGANISATION_FILTERS)),
  ]);

  // Hero stats are real metadata figures, not marketing copy: the directory
  // total plus its industry breadth. Empty renders the honest fallback line.
  const heroStats =
    meta.total > 0
      ? [
          {
            key: "organisations",
            icon: Building2,
            display: String(meta.total),
            label: meta.total === 1 ? "organisation" : "organisations",
          },
          {
            key: "industries",
            icon: Layers,
            display: String(meta.industries.length),
            label:
              meta.industries.length === 1 ? "industry" : "industries",
          },
        ]
      : [];

  return (
    <>
      <ExploreHero
        eyebrow="Expert Networks & Agencies"
        title={
          <>
            Explore <span className="silver-text">Organisations</span>
          </>
        }
        description="Discover expert networks, consulting agencies, and learning institutions on Familiarise. Book their curated experts directly."
        stats={heroStats}
        emptyStatsCopy="Check back for newly listed organisations."
      />
      <OrganisationsInteractiveContent
        metadata={meta}
        initialItems={firstPage.items}
        initialTotal={firstPage.total}
      />
    </>
  );
}

export default function ExploreOrganisationsPage() {
  return (
    <main className="min-h-screen bg-background">
      <Suspense
        fallback={
          <section className="py-10 md:py-16">
            <div className="mx-auto max-w-[1400px] px-4 md:px-8">
              <OrganisationsGridSkeleton />
            </div>
          </section>
        }
      >
        <OrganisationsDirectory />
      </Suspense>
    </main>
  );
}
