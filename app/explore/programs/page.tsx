import {
  getCuratedPrograms,
  getTopicsWithCount,
} from "@/lib/data/explore-programs";
import prisma from "@/lib/prisma";
import ProgramsInteractiveContent from "./ProgramsInteractiveContent";

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
  const [trendingPrograms, newestPrograms, topicsWithCount, stats] =
    await Promise.all([
      getCuratedPrograms("all", "trending", 8),
      getCuratedPrograms("all", "newest", 8),
      getTopicsWithCount("all"),
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

/** Counts of class plans + webinar plans for the hero stats strip.
 *  Returns null on failure so the client falls back to the marketing
 *  numbers — same fail-open behavior the old client `useEffect` had. */
async function fetchProgramStats(): Promise<{
  classCount: number;
  webinarCount: number;
} | null> {
  try {
    const [classCount, webinarCount] = await Promise.all([
      prisma.classPlan.count(),
      prisma.webinarPlan.count(),
    ]);
    return { classCount, webinarCount };
  } catch {
    return null;
  }
}
