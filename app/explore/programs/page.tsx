import {
  getCuratedPrograms,
  getTopicsWithCount,
} from "@/lib/data/explore-programs";
import { emptyOnTransientDbError } from "@/lib/data/fail-open";
import { unstable_cache } from "next/cache";
import prisma from "@/lib/prisma";
import ProgramsInteractiveContent from "./ProgramsInteractiveContent";

// Stream behind the static layout's instant skeleton; don't prerender at build (#932).
export const dynamic = "force-dynamic";

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
  // Degrade gracefully: a heavy curated read that times out (cold query brushing
  // the pg query budget) renders an empty row instead of erroring the whole page.
  const [trendingPrograms, newestPrograms, topicsWithCount, stats] =
    await Promise.all([
      getCuratedPrograms("all", "trending", 8).catch(
        emptyOnTransientDbError("trending programs"),
      ),
      getCuratedPrograms("all", "newest", 8).catch(
        emptyOnTransientDbError("newest programs"),
      ),
      getTopicsWithCount("all").catch(emptyOnTransientDbError("topics")),
      fetchProgramStats(),
    ]);

  return (
    <ProgramsInteractiveContent
      initialTrending={trendingPrograms}
      initialNewest={newestPrograms}
      initialTopics={topicsWithCount}
      initialStats={stats}
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

/** Counts of class plans + webinar plans for the hero stats strip.
 *  Returns null on failure so the client falls back to the marketing
 *  numbers — same fail-open behavior the old client `useEffect` had. */
async function fetchProgramStats(): Promise<{
  classCount: number;
  webinarCount: number;
} | null> {
  try {
    return await getCachedProgramCounts();
  } catch {
    return null;
  }
}
