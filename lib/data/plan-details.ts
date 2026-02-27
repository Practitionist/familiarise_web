import { cache } from "react";
import prisma from "@/lib/prisma";

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
    where: { id: webinarPlanId },
    include: {
      consultantProfile: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
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
              payment: true,
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
  return plan;
}

/** Cached wrapper for Server Components. */
export const getWebinarPlanDetail = cache(fetchWebinarPlanDetail);

// ---------------------------------------------------------------------------
// Class plan detail
// ---------------------------------------------------------------------------

/** Raw function — importable by API routes (no React.cache). */
export async function fetchClassPlanDetail(classPlanId: string) {
  const plan = await prisma.classPlan.findUnique({
    where: { id: classPlanId },
    include: {
      consultantProfile: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
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
  return plan;
}

/** Cached wrapper for Server Components. */
export const getClassPlanDetail = cache(fetchClassPlanDetail);
