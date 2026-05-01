import { cache } from "react";
import prisma from "@/lib/prisma";
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

// ---------------------------------------------------------------------------
// Curated programs (Featured / Trending / Newest sections)
// ---------------------------------------------------------------------------

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
        // Trending: rank by recent enrollment count (last 30 days)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const ranked = await prisma.classPlan.findMany({
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

        const sortedIds = ranked
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

        classPlans = await prisma.classPlan.findMany({
          where: { id: { in: sortedIds } },
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
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const ranked = await prisma.webinarPlan.findMany({
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

        const sortedIds = ranked
          .map((p) => ({
            id: p.id,
            count: p.webinars.reduce(
              (sum, w) =>
                sum + (w.appointment?.slotsOfAppointment?.length ?? 0),
              0,
            ),
          }))
          .sort((a, b) => b.count - a.count)
          .slice(0, limit)
          .map((r) => r.id);

        webinarPlans = await prisma.webinarPlan.findMany({
          where: { id: { in: sortedIds } },
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

    return programs.slice(0, limit);
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
            ...(planType === "all" || planType === "class"
              ? { classPlans: true }
              : {}),
            ...(planType === "all" || planType === "webinar"
              ? { webinarPlans: true }
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
