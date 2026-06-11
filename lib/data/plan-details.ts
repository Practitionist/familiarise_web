import { cache } from "react";
import prisma from "@/lib/prisma";
import { toPlain } from "@/lib/data/serialize";

/**
 * Server-side data access for webinar and class detail pages.
 *
 * Exports two flavors of each function:
 *  - Raw (e.g. fetchWebinarPlanDetail) — pure Prisma, no cache. Used by API routes.
 *  - Cached (e.g. getWebinarPlanDetail)  — React.cache() wrapper. Used by Server Components.
 */

// ---------------------------------------------------------------------------
// Webinar plan detail
// ---------------------------------------------------------------------------

/** Raw function — importable by API routes (no React.cache). */
export async function fetchWebinarPlanDetail(webinarPlanId: string) {
  const plan = await prisma.webinarPlan.findUnique({
    where: {
      id: webinarPlanId,
      // #781 §B — soft-deleted profiles leave public surfaces; owner relation
      // is nullable, so only plans with a soft-deleted owner become not-found.
      OR: [
        { consultantProfile: null },
        { consultantProfile: { deletedAt: null } },
      ],
    },
    include: {
      consultantProfile: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
              workExperiences: {
                select: { company: true, companyDomain: true, isCurrent: true },
                orderBy: [{ isCurrent: "desc" as const }, { startDate: "desc" as const }],
                take: 3,
              },
            },
          },
          domain: true,
          subDomains: true,
          tags: true,
        },
      },
      webinars: {
        include: {
          appointment: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: {
                    select: { id: true },
                  },
                },
              },
            },
          },
          waitlist: {
            select: {
              userId: true,
              position: true,
              status: true,
            },
          },
        },
      },
      topics: true,
      collaborators: {
        where: { status: "ACCEPTED" as const },
        include: {
          consultantProfile: {
            include: {
              user: {
                select: { id: true, name: true, image: true },
              },
            },
          },
        },
      },
    },
  });
  // toPlain — extended plan rows carry an inspect symbol (see serialize.ts)
  return toPlain(plan);
}

/** Cached wrapper for Server Components. */
export const getWebinarPlanDetail = cache(fetchWebinarPlanDetail);

// ---------------------------------------------------------------------------
// Class plan detail
// ---------------------------------------------------------------------------

/** Raw function — importable by API routes (no React.cache). */
export async function fetchClassPlanDetail(classPlanId: string) {
  const plan = await prisma.classPlan.findUnique({
    where: {
      id: classPlanId,
      // #781 §B — soft-deleted profiles leave public surfaces; owner relation
      // is nullable, so only plans with a soft-deleted owner become not-found.
      OR: [
        { consultantProfile: null },
        { consultantProfile: { deletedAt: null } },
      ],
    },
    include: {
      consultantProfile: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
              workExperiences: {
                select: { company: true, companyDomain: true, isCurrent: true },
                orderBy: [{ isCurrent: "desc" as const }, { startDate: "desc" as const }],
                take: 3,
              },
            },
          },
          domain: true,
          subDomains: true,
          tags: true,
        },
      },
      classes: {
        include: {
          appointments: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: {
                    select: { id: true },
                  },
                },
              },
            },
          },
          waitlist: {
            select: {
              userId: true,
              position: true,
              status: true,
            },
          },
        },
      },
      topics: true,
      classContents: true,
      collaborators: {
        where: { status: "ACCEPTED" as const },
        include: {
          consultantProfile: {
            include: {
              user: {
                select: { id: true, name: true, image: true },
              },
            },
          },
        },
      },
    },
  });
  // toPlain — extended plan rows carry an inspect symbol (see serialize.ts)
  return toPlain(plan);
}

/** Cached wrapper for Server Components. */
export const getClassPlanDetail = cache(fetchClassPlanDetail);
