/**
 * Every `/explore/**` URL, in one place.
 *
 * The program-card destination was derived from `isClassProgram` in THREE
 * places — `ProgramCard.tsx`, `FeaturedCarousel.tsx`, and a third time inside
 * `ClassesAndWebinars.tsx` on the expert profile, which re-derived the same
 * paths by reaching for `ProgramCard`. Nothing stopped those from drifting; a
 * new plan family would have needed a fourth edit and nothing would have
 * failed.
 *
 * A route table also means the recordings library gets the same treatment as
 * every other explore surface instead of being the one page with inline
 * template strings.
 */
import { isClassProgram, type Program } from "./programs";

/** Plan family → path segment. The four detail routes under `/plans`. */
export const PLAN_DETAIL_PATH = {
  CLASS: "classes",
  WEBINAR: "webinars",
  CONSULTATION: "consultations",
  SUBSCRIPTION: "subscriptions",
} as const;

export const exploreHref = {
  experts: {
    list: "/explore/experts",
    detail: (consultantId: string) => `/explore/experts/${consultantId}`,
  },
  programs: {
    list: "/explore/programs",
    detail: (id: string, isClass: boolean) =>
      `/explore/programs/plans/${isClass ? PLAN_DETAIL_PATH.CLASS : PLAN_DETAIL_PATH.WEBINAR}/${id}`,
  },
  organisations: {
    list: "/explore/enterprise/organisations",
    detail: (slug: string) => `/explore/enterprise/organisations/${slug}`,
  },
  recordings: {
    list: "/explore/recordings",
    detail: (slug: string) => `/explore/recordings/${slug}`,
  },
  community: "/explore/community",
} as const;

/** The detail path for a program card / carousel slide / rail item. */
export function programHref(program: Pick<Program, "id" | "type">): string {
  return exploreHref.programs.detail(program.id, isClassProgram(program));
}
