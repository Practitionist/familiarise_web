import { cache } from "react";
import { unstable_cache } from "next/cache";
import prisma from "@/lib/prisma";
import { toPlain } from "@/lib/data/serialize";
import type { Prisma } from "@prisma/client";
import { marketplaceVisibilityWhere } from "@/lib/api/plans/visibility";
import { generateProgramImageUrl } from "@/app/explore/programs/utils";
import type {
  Program,
  ClassPlanProgram,
  WebinarPlanProgram,
  ProgramType,
  TopicWithCount,
} from "@/app/explore/programs/utils";

/**
 * Server-side data access for the explore programs page.
 *
 * Mirrors lib/data/explore-experts.ts pattern:
 *  - Cached functions for Server Components (curated sections)
 *  - Client hooks in app/explore/programs/hooks.ts handle infinite scroll
 */

/** Shared select for consultant profile in plan queries.
 *
 * Public explore-programs surface — explicit `select` (not bare `include`) so
 * we (a) never leak India statutory PII (panNumber, ibanOrAccount, swiftBic,
 * residencyStatus, etc.) into a client component, and (b) avoid the
 * "Decimal cannot be passed to Client Components" runtime error from
 * `tdsRate: Decimal?`. Mirrors the `ProgramConsultantProfile` shape in
 * app/explore/programs/utils.ts. */
const planConsultantInclude = {
  select: {
    rating: true,
    headline: true,
    user: {
      select: {
        name: true,
        image: true,
        workExperiences: {
          select: {
            company: true,
            companyDomain: true,
            isCurrent: true,
          },
          take: 3,
        },
      },
    },
  },
};

// #781 §B — soft-deleted profiles leave public surfaces. The owner relation is
// nullable on Webinar/ClassPlan, so keep ownerless plans and drop only plans
// whose owner is soft-deleted.
const liveConsultantWhere = {
  OR: [{ consultantProfile: null }, { consultantProfile: { deletedAt: null } }],
} satisfies Prisma.ClassPlanWhereInput & Prisma.WebinarPlanWhereInput;

// ---------------------------------------------------------------------------
// Curated programs (Featured / Trending / Newest sections)
// ---------------------------------------------------------------------------

/**
 * Trending rank step 1: load every marketplace plan's last-30-day slot ids
 * and sort by count IN MEMORY. That scan is O(all plans × recent slots) per
 * call — with React.cache alone it ran once per REQUEST, so 1000 concurrent
 * explore loads each paid it. unstable_cache shares one computation across
 * requests for 60s; the cached value is just the ranked id array. Staleness
 * is harmless — trending order changing 60s late is invisible.
 */
const getTrendingClassPlanIds = unstable_cache(
  async (limit: number): Promise<string[]> => {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const ranked = await prisma.classPlan.findMany({
      where: { ...marketplaceVisibilityWhere(), ...liveConsultantWhere }, // #726 — no ORG_ONLY in curated feed
      select: {
        id: true,
        classes: {
          select: {
            appointments: {
              select: {
                slotsOfAppointment: {
                  where: { createdAt: { gte: thirtyDaysAgo } },
                  select: { id: true },
                },
              },
            },
          },
        },
      },
    });

    return ranked
      .map((p) => ({
        id: p.id,
        count: p.classes.reduce(
          (sum, cls) =>
            sum +
            cls.appointments.reduce(
              (s, apt) => s + apt.slotsOfAppointment.length,
              0,
            ),
          0,
        ),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((r) => r.id);
  },
  ["trending-class-plan-ids"],
  { revalidate: 60 },
);

const getTrendingWebinarPlanIds = unstable_cache(
  async (limit: number): Promise<string[]> => {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const ranked = await prisma.webinarPlan.findMany({
      where: { ...marketplaceVisibilityWhere(), ...liveConsultantWhere }, // #726 — no ORG_ONLY in curated feed
      select: {
        id: true,
        webinars: {
          select: {
            appointment: {
              select: {
                slotsOfAppointment: {
                  where: { createdAt: { gte: thirtyDaysAgo } },
                  select: { id: true },
                },
              },
            },
          },
        },
      },
    });

    return ranked
      .map((p) => ({
        id: p.id,
        count: p.webinars.reduce(
          (sum, w) => sum + (w.appointment?.slotsOfAppointment?.length ?? 0),
          0,
        ),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((r) => r.id);
  },
  ["trending-webinar-plan-ids"],
  { revalidate: 60 },
);

/**
 * Fetch curated programs for server-rendered sections.
 * Combines class plans + webinar plans, normalizes into Program[].
 */
export const getCuratedPrograms = cache(
  async (
    programType: ProgramType,
    sort: "trending" | "newest",
    limit: number = 8,
  ): Promise<Program[]> => {
    const programs: Program[] = [];

    // Build orderBy for non-trending sorts
    const orderBy =
      sort === "newest" ? { createdAt: "desc" as const } : undefined;

    // Fetch class plans
    if (programType === "all" || programType === "class") {
      let classPlans;

      if (sort === "trending") {
        // Trending: rank by recent enrollment count (last 30 days) — the
        // ranking scan is shared across requests via unstable_cache above.
        const sortedIds = await getTrendingClassPlanIds(limit);

        classPlans = await prisma.classPlan.findMany({
          where: {
            id: { in: sortedIds },
            ...marketplaceVisibilityWhere(),
            ...liveConsultantWhere,
          }, // #726
          include: {
            consultantProfile: planConsultantInclude,
            topics: true,
            classContents: true,
            classes: true,
          },
        });

        // Re-sort to match ranking order
        const idOrder = new Map(sortedIds.map((id, i) => [id, i]));
        classPlans.sort(
          (a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0),
        );
      } else {
        classPlans = await prisma.classPlan.findMany({
          where: { ...marketplaceVisibilityWhere(), ...liveConsultantWhere }, // #726
          include: {
            consultantProfile: planConsultantInclude,
            topics: true,
            classContents: true,
            classes: true,
          },
          ...(orderBy && { orderBy }),
          take: limit,
        });
      }

      programs.push(
        ...classPlans.map(
          (plan): ClassPlanProgram => ({
            ...plan,
            classes: plan.classes || [],
            type: "class",
            imageUrl: generateProgramImageUrl(
              plan.id,
              600,
              400,
              plan.imageUrl,
            ),
          }),
        ),
      );
    }

    // Fetch webinar plans
    if (programType === "all" || programType === "webinar") {
      let webinarPlans;

      if (sort === "trending") {
        // Shared 60s ranking cache — see getTrendingWebinarPlanIds above.
        const sortedIds = await getTrendingWebinarPlanIds(limit);

        webinarPlans = await prisma.webinarPlan.findMany({
          where: {
            id: { in: sortedIds },
            ...marketplaceVisibilityWhere(),
            ...liveConsultantWhere,
          }, // #726
          include: {
            consultantProfile: planConsultantInclude,
            topics: true,
          },
        });

        const idOrder = new Map(sortedIds.map((id, i) => [id, i]));
        webinarPlans.sort(
          (a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0),
        );
      } else {
        webinarPlans = await prisma.webinarPlan.findMany({
          where: { ...marketplaceVisibilityWhere(), ...liveConsultantWhere }, // #726
          include: {
            consultantProfile: planConsultantInclude,
            topics: true,
          },
          ...(orderBy && { orderBy }),
          take: limit,
        });
      }

      programs.push(
        ...webinarPlans.map(
          (plan): WebinarPlanProgram => ({
            ...plan,
            webinars: [],
            type: "webinar",
            imageUrl: generateProgramImageUrl(
              plan.id,
              600,
              400,
              plan.imageUrl,
            ),
          }),
        ),
      );
    }

    // For newest with combined results, re-sort by createdAt
    if (sort === "newest" && programType === "all") {
      programs.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    }

    // toPlain — extended plan rows carry an inspect symbol (see serialize.ts)
    return toPlain(programs.slice(0, limit));
  },
);

// ---------------------------------------------------------------------------
// Topics with program counts (for category grid)
// ---------------------------------------------------------------------------

export const getTopicsWithCount = cache(
  async (planType: ProgramType = "all"): Promise<TopicWithCount[]> => {
    const topics = await prisma.topic.findMany({
      include: {
        _count: {
          select: {
            // #726 — category counts must exclude ORG_ONLY plans too
            // #781 §B — and plans whose owner is soft-deleted
            ...(planType === "all" || planType === "class"
              ? {
                  classPlans: {
                    where: {
                      ...marketplaceVisibilityWhere(),
                      ...liveConsultantWhere,
                    },
                  },
                }
              : {}),
            ...(planType === "all" || planType === "webinar"
              ? {
                  webinarPlans: {
                    where: {
                      ...marketplaceVisibilityWhere(),
                      ...liveConsultantWhere,
                    },
                  },
                }
              : {}),
          },
        },
      },
      orderBy: { name: "asc" },
    });

    return topics
      .map((topic) => {
        const count = topic._count;
        let programCount = 0;
        if (planType === "class") {
          programCount = count.classPlans ?? 0;
        } else if (planType === "webinar") {
          programCount = count.webinarPlans ?? 0;
        } else {
          programCount = (count.classPlans ?? 0) + (count.webinarPlans ?? 0);
        }
        return { id: topic.id, name: topic.name, programCount };
      })
      .filter((t) => t.programCount > 0)
      .sort((a, b) => b.programCount - a.programCount);
  },
);
