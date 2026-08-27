import { Sparkles } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";

import { SpotlightGrid } from "@/components/motion";
import {
  DEFAULT_ORGANISATION_FILTERS,
  getOrganisationsMetadata,
  getOrganisationsPage,
} from "@/lib/data/explore-organisations";
import { withBuildTimeRetry } from "@/lib/data/fail-open";

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

  return (
    <OrganisationsInteractiveContent
      metadata={meta}
      initialItems={firstPage.items}
      initialTotal={firstPage.total}
    />
  );
}

export default function ExploreOrganisationsPage() {
  return (
    <main className="min-h-screen bg-background">
      {/* Hero — same left-aligned stage as the experts/programs listings */}
      <section className="relative overflow-hidden bg-zinc-950 pt-36 pb-16">
        <SpotlightGrid className="opacity-60" />
        <div
          aria-hidden
          className="pointer-events-none absolute -top-32 left-1/2 h-[360px] w-[720px] -translate-x-1/2 rounded-full bg-zinc-500/10 blur-[120px]"
        />

        <div className="relative z-10 mx-auto max-w-[1400px] px-4 md:px-8">
          <div className="max-w-3xl">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1 text-xs text-zinc-300">
              <Sparkles className="h-3.5 w-3.5" />
              Expert Networks &amp; Agencies
            </div>
            <h1 className="text-fluid-4xl md:text-fluid-5xl mb-5 font-bold leading-[1.05] tracking-tight text-white">
              Explore <span className="silver-text">Organisations</span>
            </h1>
            <p className="max-w-xl text-lg text-zinc-400">
              Expert networks, consulting agencies, and learning institutions —
              book their curated experts directly.
            </p>
          </div>
        </div>
      </section>

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
