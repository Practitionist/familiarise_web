import {
  getCuratedPrograms,
  getTopicsWithCount,
} from "@/lib/data/explore-programs";
import {
  emptyOnTransientDbError,
  fallbackOnTransientDbError,
} from "@/lib/data/fail-open";
import { sortPlanLevels } from "@/lib/labels/plan-labels";
import { unstable_cache } from "next/cache";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import ProgramsInteractiveContent from "./ProgramsInteractiveContent";

// #664 — the viewer's ACTIVE org memberships, as { orgId: orgName }. Viewer-
// specific, so it must NOT enter the shared curated cache — it's fetched
// per-request here and prop-drilled to the card, which badges a plan
// "Recommended by <org>" when the viewer's org sponsors that plan's program.
//
// Signed-out returns {} here because that is an ANSWER, not a failure. Failure
// is handled at the call site by the same fail-open helper the four sibling
// reads use — this used to be a bare `catch { return {} }`, which swallowed
// every error class and would have silently dropped every org badge on a mapper
// or schema regression, indefinitely and with no signal. (#1125)
async function getViewerOrgs(): Promise<Record<string, string>> {
  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) return {};
  const memberships = await prisma.membership.findMany({
    where: { userId, status: "ACTIVE" },
    select: { organization: { select: { id: true, name: true } } },
  });
  return Object.fromEntries(
    memberships.map((m) => [m.organization.id, m.organization.name]),
  );
}

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
  const [
    trendingPrograms,
    newestPrograms,
    topicsWithCount,
    stats,
    viewerOrgs,
    levels,
  ] = await Promise.all([
    getCuratedPrograms("all", "trending", 8).catch(
      emptyOnTransientDbError("trending programs", { perRequest: true }),
    ),
    getCuratedPrograms("all", "newest", 8).catch(
      emptyOnTransientDbError("newest programs", { perRequest: true }),
    ),
    getTopicsWithCount("all").catch(
      emptyOnTransientDbError("topics", { perRequest: true }),
    ),
    // `null` here means "show the marketing numbers instead", which the client
    // already handles. Routed through the helper rather than a local catch so a
    // real defect surfaces instead of quietly pinning the hero to placeholders.
    getCachedProgramCounts().catch(
      fallbackOnTransientDbError("program stats", null, { perRequest: true }),
    ),
    getViewerOrgs().catch(
      fallbackOnTransientDbError<Record<string, string>>(
        "viewer orgs",
        {},
        {
          perRequest: true,
        },
      ),
    ),
    getCachedProgramLevels().catch(
      emptyOnTransientDbError("program levels", { perRequest: true }),
    ),
  ]);

  return (
    <ProgramsInteractiveContent
      initialTrending={trendingPrograms}
      initialNewest={newestPrograms}
      initialTopics={topicsWithCount}
      initialStats={stats}
      viewerOrgs={viewerOrgs}
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
