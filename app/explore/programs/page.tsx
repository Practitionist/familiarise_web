import {
  getCuratedPrograms,
  getDefaultProgramsPage,
  getTopicsWithCount,
} from "@/lib/data/explore-programs";
import { withBuildTimeRetry } from "@/lib/data/fail-open";
import { sortPlanLevels } from "@/lib/labels/plan-labels";
import { unstable_cache } from "next/cache";
import prisma from "@/lib/prisma";
import ProgramsInteractiveContent from "./ProgramsInteractiveContent";

// ISR: every read below is viewer-agnostic, so the page is the same for every
// visitor and an ISR copy served from the durable cache skips the function
// invocation entirely — the only lever that avoids the cold-instance stall
// (#1124). The one per-viewer bit, the "Recommended by <org>" badge (#664),
// resolves in the browser from session.user.organizationMemberships inside
// ProgramsInteractiveContent; nothing viewer-specific may re-enter this
// server render or the route silently pins back to dynamic.
// 300 matches the data-layer windows: the route's effective revalidate is the
// MIN of this and every unstable_cache window read during the render (#1110).
export const revalidate = 300;

/**
 * Server-fetch the trending / newest curated rows, the topic list, and the
 * stats counts in parallel. The interactive client component receives them
 * as props and uses them as `initialData` for its React Query hooks, so the
 * first paint after navigation doesn't wait on a client fetch.
 *
 * Mirrors the architecture of `/explore/experts/page.tsx`. Tab switches
 * still trigger client-side React Query refetches via the existing
 * `useCuratedPrograms` / `useTopicsWithCount` hooks.
 */
export default async function ExplorePrograms() {
  // These used to degrade to empty rows per-request. Now that this route is
  // ISR, a degraded 200 would be written to the durable cache and replayed to
  // everyone until the window expired (#1123) — so retry once during build and
  // otherwise throw, which caches nothing and lands in error.tsx instead.
  const [
    trendingPrograms,
    newestPrograms,
    topicsWithCount,
    stats,
    levels,
    defaultProgramsPage,
  ] = await Promise.all([
    withBuildTimeRetry(() => getCuratedPrograms("all", "trending", 8)),
    withBuildTimeRetry(() => getCuratedPrograms("all", "newest", 8)),
    withBuildTimeRetry(() => getTopicsWithCount("all")),
    withBuildTimeRetry(getCachedProgramCounts),
    withBuildTimeRetry(getCachedProgramLevels),
    // Page 1 of the anonymous default grid — seeds the client usePrograms
    // query so the All Programs section paints with the HTML instead of a
    // second skeleton-then-fetch pass.
    withBuildTimeRetry(getDefaultProgramsPage),
  ]);

  return (
    <ProgramsInteractiveContent
      initialTrending={trendingPrograms}
      initialNewest={newestPrograms}
      initialTopics={topicsWithCount}
      initialStats={stats}
      initialProgramsPage={defaultProgramsPage}
      availableLevels={levels}
    />
  );
}

// Marketing counts change slowly (a few plans/day) — cache cross-request for an
// hour rather than re-running two aggregates on every explore visit (#932 perf).
const getCachedProgramCounts = unstable_cache(
  async () => {
    const [classCount, webinarCount] = await Promise.all([
      prisma.classPlan.count(),
      prisma.webinarPlan.count(),
    ]);
    return { classCount, webinarCount };
  },
  ["program-stats"],
  { revalidate: 3600, tags: ["programs"] },
);

/** Every level that exists across both plan families.
 *
 *  The level dropdown used to be derived from whatever infinite-scroll had
 *  already loaded (`getUniqueLevels(programs)`), so a level that only appeared
 *  on a later page was not offerable — and picking one then filtered only the
 *  loaded rows. Levels are a small, slow-moving set; read them once. */
// Not exported: Next.js allows only a fixed set of exports from a page module,
// and a stray one fails `next build` (which `tsc --noEmit` cannot catch).
const getCachedProgramLevels = unstable_cache(
  async () => {
    const [classLevels, webinarLevels] = await Promise.all([
      prisma.classPlan.findMany({
        select: { level: true },
        distinct: ["level"],
      }),
      prisma.webinarPlan.findMany({
        select: { level: true },
        distinct: ["level"],
      }),
    ]);
    // Still read from the DB rather than listing the enum: the facet should
    // only offer levels that some plan actually has.
    return sortPlanLevels([
      ...new Set([...classLevels, ...webinarLevels].map((row) => row.level)),
    ]);
  },
  ["program-levels"],
  { revalidate: 3600, tags: ["programs"] },
);
