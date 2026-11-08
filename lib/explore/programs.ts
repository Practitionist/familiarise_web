/**
 * Explore-programs domain helpers and shapes.
 *
 * Moved out of `app/explore/programs/utils.ts`: `lib/data/explore-programs.ts`
 * imported FUNCTIONS from it, which made the data layer depend on a route
 * folder at runtime — the wrong direction, and the only non-type instance of it
 * left in the codebase. Nothing here is routing; it is pagination constants,
 * program shapes and an image-URL builder.
 */
import {
  ClassPlan as PrismaClassPlan,
  WebinarPlan as PrismaWebinarPlan,
} from "@prisma/client";

export const ITEMS_PER_PAGE = 12;

// A search this short matches nearly every plan, and the server answers it with
// a scan, so it is not worth sending. The ceiling bounds what one request asks
// the database to match.
const SEARCH_MIN_CHARS = 2;
const SEARCH_MAX_CHARS = 100;

/** Trims, collapses whitespace and caps length; `undefined` when too short to search. */
export function normaliseSearchTerm(
  raw: string | null | undefined,
): string | undefined {
  const term = (raw ?? "")
    .replace(/\s+/g, " ")
    .slice(0, SEARCH_MAX_CHARS)
    .trim();
  return term.length >= SEARCH_MIN_CHARS ? term : undefined;
}

export type ProgramType = "all" | "class" | "webinar";

// A public list never says who holds a seat. "Am I registered" is the viewer's
// own and arrives as `isRegistered` from `useMyEventSeats`.
export interface WebinarInstance {
  id: string;
}

export interface ClassInstance {
  id: string;
  schedulingPeriodStartsAt?: string | Date | null;
  /** Per-instance capacity override; null inherits the plan's value. */
  maxParticipants?: number | null;
  /** `_count` is the seats taken, host excluded. */
  appointment?: { id: string; _count?: { participants: number } } | null;
}

type ProgramConsultantProfile = {
  /** #1300 — the two published scores. NULL on either means SUPPRESSED, which a
   *  card must render as nothing rather than as 0.0. Resolve with
   *  `displayedScore` from lib/reviews, preferring GROUP on a program card. */
  publishedRatingOneToOne?: number | null;
  publishedRatingGroup?: number | null;
  ratedClientsOneToOne?: number;
  ratedEventsGroup?: number;
  headline?: string | null;
  user?: {
    name?: string | null;
    image?: string | null;
    workExperiences?: Array<{
      company: string;
      companyDomain: string | null;
      isCurrent: boolean;
    }>;
  };
};

type ProgramCollaborator = {
  consultantProfile?: ProgramConsultantProfile | null;
};

// #780 — price reaches here as number (extended-client read → JSON), never bigint
export type ClassPlanProgram = Omit<PrismaClassPlan, "price"> & {
  price: number;
  classes: ClassInstance[];
  type: "class";
  imageUrl: string;
  isRegistered?: boolean;
  consultantProfile?: ProgramConsultantProfile | null;
  collaborators?: ProgramCollaborator[];
};

export type WebinarPlanProgram = Omit<PrismaWebinarPlan, "price"> & {
  price: number;
  webinars?: WebinarInstance[];
  type: "webinar";
  imageUrl: string;
  isRegistered?: boolean;
  consultantProfile?: ProgramConsultantProfile | null;
  collaborators?: ProgramCollaborator[];
};

export type Program = ClassPlanProgram | WebinarPlanProgram;

export interface ApiMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface TopicWithCount {
  id: string;
  name: string;
  programCount: number;
}

export interface ProgramFilters {
  topicIds?: string[];
  language?: string;
  domainId?: string;
  sort?: string;
  minPrice?: number;
  maxPrice?: number;
  search?: string;
  /** "all" is the UI sentinel for "no level filter" and is never sent. */
  level?: string;
}

export const PROGRAM_COVER_PLACEHOLDER = "/placeholder.svg";

// Program cover: the DB image when present, else the local static placeholder.
export function generateProgramImageUrl(dbImageUrl?: string | null): string {
  return dbImageUrl || PROGRAM_COVER_PLACEHOLDER;
}

export function isClassProgram(program: Program): program is ClassPlanProgram {
  return program.type === "class";
}

// `filterAndSortPrograms` and `getUniqueLevels` used to re-filter search/level
// on the client over the already-loaded infinite-scroll page, which meant a
// matching program on a later page never appeared and the level dropdown could
// only offer levels that happened to be loaded. Both are now server-side:
// `level` joins the shared where-builder in app/api/plans/shared/plan-filters.ts,
// and the level list comes from `getCachedProgramLevels` in the RSC.
