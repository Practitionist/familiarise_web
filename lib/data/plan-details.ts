import { cache } from "react";
import prisma from "@/lib/prisma";
import { planBuyBlockedFor } from "@/lib/booking/plan-demand";
import { seatHoldingParticipant } from "@/utils/scheduling-engine/occupancyPolicy";
import { toPlain } from "@/lib/data/serialize";
import { consultantPublicScalars } from "@/lib/data/consultant-public";
import {
  planCollaboratorScalars,
  planConsultantUserSelect,
} from "@/lib/api/plans/consultant-projection";

/**
 * Server-side data access for the four plan detail pages.
 *
 * Exports two flavors of each function:
 *  - Raw (e.g. fetchWebinarPlanDetail) — pure Prisma, no cache. Used by API routes.
 *  - Cached (e.g. getWebinarPlanDetail)  — React.cache() wrapper. Used by Server Components.
 */

// ---------------------------------------------------------------------------
// Webinar plan detail
// ---------------------------------------------------------------------------

/** Public plan pages list each material's name and type, never its storage path or a link. */
const publicMaterialsInclude = {
  orderBy: { order: "asc" as const },
  select: {
    id: true,
    originalName: true,
    description: true,
    mimeType: true,
    fileSize: true,
    order: true,
  },
};

/**
 * How many seats hold a place on an event right now, as a number: the public
 * payload never carries who they belong to. The host's own row has another
 * role, so it never counts, and a lapsed unpaid hold stops counting, which is
 * the rule checkout applies.
 */
const seatCount = (now: Date) => ({
  select: { participants: { where: seatHoldingParticipant(now) } },
});

/** Raw function — importable by API routes (no React.cache). */
export async function fetchWebinarPlanDetail(webinarPlanId: string) {
  const now = new Date();
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
      materials: publicMaterialsInclude,
      consultantProfile: {
        select: {
          ...consultantPublicScalars,
          user: planConsultantUserSelect,
          domain: true,
          subDomains: true,
          tags: true,
        },
      },
      webinars: {
        include: {
          appointment: {
            include: {
              occurrences: true,
              _count: seatCount(now),
            },
          },
        },
      },
      topics: true,
      faqs: { orderBy: { order: "asc" } },
      collaborators: {
        // A soft-deleted (erased) profile leaves the public co-host list even
        // if its row somehow stayed ACCEPTED (#1580).
        where: {
          status: "ACCEPTED" as const,
          consultantProfile: { deletedAt: null },
        },
        select: {
          ...planCollaboratorScalars,
          consultantProfile: {
            select: {
              ...consultantPublicScalars,
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
  const now = new Date();
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
      materials: publicMaterialsInclude,
      consultantProfile: {
        select: {
          ...consultantPublicScalars,
          user: planConsultantUserSelect,
          domain: true,
          subDomains: true,
          tags: true,
        },
      },
      classes: {
        // #1819 — a stable pre-order; the first-session sort below is final.
        orderBy: [{ schedulingPeriodStartsAt: "asc" }, { createdAt: "asc" }],
        include: {
          appointment: {
            include: {
              occurrences: { orderBy: { startsAt: "asc" } },
              _count: seatCount(now),
            },
          },
        },
      },
      topics: true,
      faqs: { orderBy: { order: "asc" } },
      classContents: { orderBy: { order: "asc" } },
      collaborators: {
        // A soft-deleted (erased) profile leaves the public co-host list even
        // if its row somehow stayed ACCEPTED (#1580).
        where: {
          status: "ACCEPTED" as const,
          consultantProfile: { deletedAt: null },
        },
        select: {
          ...planCollaboratorScalars,
          consultantProfile: {
            select: {
              ...consultantPublicScalars,
              user: {
                select: { id: true, name: true, image: true },
              },
            },
          },
        },
      },
    },
  });
  if (plan) plan.classes.sort((a, b) => firstStart(a) - firstStart(b));
  // toPlain — extended plan rows carry an inspect symbol (see serialize.ts)
  return toPlain(plan);
}

/** #1819 — a batch's first live session, so batches order by when they run. */
function firstStart(cls: {
  appointment: {
    occurrences: { startsAt: Date; deletedAt: Date | null }[];
  } | null;
}): number {
  const live = cls.appointment?.occurrences.find((o) => !o.deletedAt);
  return live ? live.startsAt.getTime() : Number.MAX_SAFE_INTEGER;
}

/** Cached wrapper for Server Components. */
export const getClassPlanDetail = cache(fetchClassPlanDetail);

// ---------------------------------------------------------------------------
// Subscription plan detail
// ---------------------------------------------------------------------------

/**
 * Owner select shared by the subscription and consultation fetchers.
 *
 * Both are 1:1 products whose owner relation is REQUIRED (unlike webinar and
 * class, where an org can own a plan with no consultant), so neither needs the
 * nullable-owner branch the other two carry.
 */
const planOwnerSelect = {
  select: {
    ...consultantPublicScalars,
    user: planConsultantUserSelect,
    domain: true,
    subDomains: true,
    tags: true,
  },
};

/** Raw function — importable by API routes (no React.cache). */
export async function fetchSubscriptionPlanDetail(subscriptionPlanId: string) {
  const plan = await prisma.subscriptionPlan.findUnique({
    where: {
      id: subscriptionPlanId,
      // #781 §B — a soft-deleted owner takes the plan off public surfaces.
      consultantProfile: { deletedAt: null },
    },
    include: {
      consultantProfile: planOwnerSelect,
      topics: true,
      faqs: { orderBy: { order: "asc" } },
      subscriptionContents: { orderBy: { order: "asc" } },
      materials: publicMaterialsInclude,
    },
  });
  // toPlain — extended plan rows carry an inspect symbol (see serialize.ts)
  return toPlain(plan);
}

/** Cached wrapper for Server Components. */
export const getSubscriptionPlanDetail = cache(fetchSubscriptionPlanDetail);

/**
 * Whether this viewer is turned away by the expert's plan-client limit: the
 * limit is reached and they hold none of the expert's plans. Per request only.
 */
export const getPlanBuyBlockedFor = cache(
  (consultantProfileId: string, viewerUserId: string | null) =>
    planBuyBlockedFor(prisma, consultantProfileId, viewerUserId),
);

// ---------------------------------------------------------------------------
// Consultation plan detail
// ---------------------------------------------------------------------------

/** Raw function — importable by API routes (no React.cache). */
export async function fetchConsultationPlanDetail(consultationPlanId: string) {
  const plan = await prisma.consultationPlan.findUnique({
    where: {
      id: consultationPlanId,
      consultantProfile: { deletedAt: null },
    },
    include: {
      consultantProfile: planOwnerSelect,
      topics: true,
      faqs: { orderBy: { order: "asc" } },
      materials: publicMaterialsInclude,
    },
  });
  return toPlain(plan);
}

/** Cached wrapper for Server Components. */
export const getConsultationPlanDetail = cache(fetchConsultationPlanDetail);
