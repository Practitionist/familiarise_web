import { cache } from "react";
import prisma from "@/lib/prisma";
import {
  eventPlanDiscoverableWhere,
  oneOnOnePlanDiscoverableWhere,
} from "@/lib/api/plans/visibility";

// One select for all four plan relations so the org card shape cannot drift
// per type. `subtitle` is the line the card renders under the title.
const PUBLIC_PLAN_CARD_SELECT = {
  id: true,
  title: true,
  subtitle: true,
  description: true,
  price: true,
  priceCurrency: true,
} as const;

// React.cache so generateMetadata() and the page body share one query per request
// instead of running this heavy org read twice (more visible now it's per-request).
export const fetchOrgBySlug = cache(async (slug: string) => {
  const row = await prisma.organization.findFirst({
    // canHost intentionally absent: the directory lists every opted-in ACTIVE
    // org, so requiring it here would 404 exactly the orgs the index links to.
    where: { slug, isPublic: true, status: "ACTIVE", deletedAt: null },
    select: {
      id: true,
      name: true,
      slug: true,
      canSponsor: true,
      canHost: true,
      brandingProfile: {
        select: {
          logo: true,
          bannerImage: true,
          description: true,
          industry: true,
          website: true,
          sizeBucket: true,
          directoryType: true,
        },
      },
      // #778 elegance — the org "catalog" is its org-owned per-type plans
      // (organizationId set on the plan) that are publicly visible. The standalone
      // OrganizationPlan model was collapsed into these (one bookable shape).
      //
      // #catalog-archive — this page previously filtered `visibility` but not
      // `archivedAt`, so a withdrawn plan still rendered here and linked
      // straight into checkout. It was the one public surface bypassing
      // eventPlanDiscoverableWhere(); all four now carry the archive gate.
      // #1527 Q4 — 1:1 and subscription plans also hide drafts.
      consultationPlans: {
        where: oneOnOnePlanDiscoverableWhere(),
        select: PUBLIC_PLAN_CARD_SELECT,
        take: 6,
      },
      subscriptionPlans: {
        where: oneOnOnePlanDiscoverableWhere(),
        select: PUBLIC_PLAN_CARD_SELECT,
        take: 6,
      },
      webinarPlans: {
        where: eventPlanDiscoverableWhere(),
        select: PUBLIC_PLAN_CARD_SELECT,
        take: 6,
      },
      classPlans: {
        where: eventPlanDiscoverableWhere(),
        select: PUBLIC_PLAN_CARD_SELECT,
        take: 6,
      },
      memberships: {
        where: {
          role: "EXPERT",
          status: "ACTIVE",
          consultantProfile: {
            verificationStatus: "VERIFIED",
            // NOT filtered on `isIndependent: false`. That column is derived —
            // "true iff zero ACTIVE EXPERT memberships at canHost orgs" — and is
            // only recomputed by recomputeConsultantIsIndependent() after a
            // membership mutation. Anything that writes memberships directly
            // (the seed, a backfill, a manual fix) leaves it stale, and a stale
            // `true` hid every expert on this page even though the membership
            // being selected here is itself the proof they aren't independent.
            // The join is the source of truth; the flag is a cache of it.
            deletedAt: null,
          },
        },
        select: {
          consultantProfile: {
            select: {
              id: true,
              headline: true,
              // #1300 — the PUBLISHED scores, not the raw mean. This page is
              // public and two of five organisations are `isPublic`, and it used
              // to render `rating.toFixed(1)` with no guard at all: a consultant
              // with one five-star review read "5.0" and one with none read
              // "0.0", which are precisely the two outcomes the publication
              // threshold exists to prevent.
              publishedRatingOneToOne: true,
              publishedRatingGroup: true,
              ratedClientsOneToOne: true,
              ratedEventsGroup: true,
              isVerified: true,
              experience: true,
              user: {
                select: { name: true, image: true, profileDisplayImage: true },
              },
              domain: { select: { name: true } },
            },
          },
        },
        take: 12,
      },
    },
  });
  if (!row) return null;
  // Normalize the four org-owned per-type plan lists into one catalog array,
  // tagged with planType, so the sidebar render is unchanged.
  const organizationPlans = [
    ...row.consultationPlans.map((p) => ({
      ...p,
      planType: "CONSULTATION" as const,
    })),
    ...row.subscriptionPlans.map((p) => ({
      ...p,
      planType: "SUBSCRIPTION" as const,
    })),
    ...row.webinarPlans.map((p) => ({ ...p, planType: "WEBINAR" as const })),
    ...row.classPlans.map((p) => ({ ...p, planType: "CLASS" as const })),
  ].slice(0, 6);
  // Flatten brandingProfile into the org shape so the rest of the page reads
  // org.logo / org.description / etc. directly (avoids touching ~12 read sites).
  return {
    ...row,
    organizationPlans,
    logo: row.brandingProfile?.logo ?? null,
    bannerImage: row.brandingProfile?.bannerImage ?? null,
    description: row.brandingProfile?.description ?? null,
    industry: row.brandingProfile?.industry ?? null,
    // Rendered as a public href, so anything but http(s) is dropped.
    website: /^https?:\/\//i.test(row.brandingProfile?.website ?? "")
      ? (row.brandingProfile?.website ?? null)
      : null,
    sizeBucket: row.brandingProfile?.sizeBucket ?? null,
    directoryType: row.brandingProfile?.directoryType ?? null,
  };
});
