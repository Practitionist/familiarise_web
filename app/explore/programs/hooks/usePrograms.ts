"use client";

import { useInfiniteQuery, keepPreviousData } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  isUserEnrolled,
  isUserRegisteredForWebinar,
} from "@/lib/payments/utils/participants";
import {
  ITEMS_PER_PAGE,
  generateProgramImageUrl,
  type ApiMeta,
  type Program,
  type ProgramType,
  type ProgramFilters,
  type ClassPlanProgram,
  type WebinarPlanProgram,
} from "@/lib/explore/programs";
import {
  buildFilterParams,
  fetchPlans,
  type PlanApiResponse,
  type ClassPlanApiItem,
  type WebinarPlanApiItem,
} from "./_helpers";

interface UseProgramsOptions {
  userId?: string | null;
  filters?: ProgramFilters;
  /** Server-rendered page 1 of the anonymous, unfiltered default view
   *  (lib/data getDefaultProgramsPage) — seeds the "all" query so the grid
   *  paints without a client fetch. `data` is untyped for the same reason
   *  fetchPlans trusts `res.json()`: both sides carry the API's list shape. */
  initialPage?: {
    classResponse: { data: unknown[]; meta: ApiMeta };
    webinarResponse: { data: unknown[]; meta: ApiMeta };
  };
}

interface ProgramsQueryPage {
  programs: Program[];
  classMeta?: ApiMeta;
  webinarMeta?: ApiMeta;
}

/**
 * Map raw plan-list responses into one query page. Shared by the queryFn
 * (live /api/plans/* responses) and the RSC seed (getDefaultProgramsPage),
 * so the seeded page cannot drift from what a real fetch would produce.
 * Response order matches the request order in the queryFn: classes first
 * when the tab includes classes, webinars after.
 */
function buildProgramsPage(
  programType: ProgramType,
  userId: string | null | undefined,
  responses: PlanApiResponse[],
): ProgramsQueryPage {
  let combinedPrograms: Program[] = [];
  let classMeta: ApiMeta | undefined;
  let webinarMeta: ApiMeta | undefined;

  if ((programType === "all" || programType === "class") && responses[0]) {
    const classResponse = responses[0];
    classMeta = classResponse.meta;
    if (classResponse.data) {
      const formattedClasses = classResponse.data.map(
        (plan): ClassPlanProgram => {
          const typedPlan = plan as ClassPlanApiItem;
          const classes = typedPlan.classes || [];
          const appointments = classes.flatMap((c) => c.appointments ?? []);
          const isRegistered =
            userId && appointments.length > 0
              ? isUserEnrolled(appointments, userId)
              : false;

          return {
            ...typedPlan,
            classes,
            type: "class",
            imageUrl: generateProgramImageUrl(
              typedPlan.id,
              600,
              400,
              typedPlan.imageUrl,
            ),
            isRegistered,
          } as ClassPlanProgram;
        },
      );
      combinedPrograms = [...combinedPrograms, ...formattedClasses];
    }
  }

  if (programType === "all" || programType === "webinar") {
    const webinarResponseIndex = programType === "all" ? 1 : 0;
    if (responses[webinarResponseIndex]) {
      const webinarResponse = responses[webinarResponseIndex];
      webinarMeta = webinarResponse.meta;
      if (webinarResponse.data) {
        const formattedWebinars = webinarResponse.data.map(
          (plan): WebinarPlanProgram => {
            const typedPlan = plan as WebinarPlanApiItem;
            const webinars = typedPlan.webinars || [];
            const isRegistered =
              userId && webinars.length > 0
                ? isUserRegisteredForWebinar(webinars, userId)
                : false;

            return {
              ...typedPlan,
              webinars,
              type: "webinar",
              imageUrl: generateProgramImageUrl(
                typedPlan.id,
                600,
                400,
                typedPlan.imageUrl,
              ),
              isRegistered,
            } as WebinarPlanProgram;
          },
        );
        combinedPrograms = [...combinedPrograms, ...formattedWebinars];
      }
    }
  }

  return { programs: combinedPrograms, classMeta, webinarMeta };
}

/**
 * Infinite query for the main "All Programs" listing on the explore
 * programs page. Combines class plans and webinar plans into a single
 * `Program[]` and tracks pagination metadata across both endpoints.
 */
export function usePrograms(
  programType: ProgramType,
  options: UseProgramsOptions = {},
) {
  const { userId, filters = {}, initialPage } = options;
  const includeRegistration = !!userId;
  const filterStr = buildFilterParams(filters);

  // Seed exactly one query: the anonymous, unfiltered "all" view — the key
  // the server pre-rendered. The key contains `userId`, which is undefined
  // while useSession() resolves; when it lands for a signed-in user the key
  // flips and the refetch recomputes isRegistered (keepPreviousData below
  // keeps the seeded rows on screen instead of re-skeletoning the grid).
  const seededInitialData = useMemo(() => {
    if (!initialPage || programType !== "all" || filterStr !== "" || userId) {
      return undefined;
    }
    return {
      pages: [
        buildProgramsPage("all", undefined, [
          initialPage.classResponse as PlanApiResponse,
          initialPage.webinarResponse as PlanApiResponse,
        ]),
      ],
      pageParams: [0],
    };
  }, [initialPage, programType, filterStr, userId]);

  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isLoading,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["programs", programType, userId, filterStr],
    queryFn: async ({ pageParam = 0 }) => {
      const requests = [];

      const registrationParam = includeRegistration
        ? "&includeRegistration=true"
        : "";

      if (programType === "all" || programType === "class") {
        requests.push(
          `/api/plans/classes?page=${pageParam + 1}&limit=${ITEMS_PER_PAGE}&include=classes${registrationParam}${filterStr}`,
        );
      }
      if (programType === "all" || programType === "webinar") {
        requests.push(
          `/api/plans/webinars?page=${pageParam + 1}&limit=${ITEMS_PER_PAGE}${registrationParam}${filterStr}`,
        );
      }

      const responses = await Promise.all(
        requests.map((url) => fetchPlans(url)),
      );

      return buildProgramsPage(programType, userId, responses);
    },
    getNextPageParam: (lastPage, pages) => {
      let hasMoreClasses = false;
      let hasMoreWebinars = false;

      if (programType === "all" || programType === "class") {
        if (lastPage.classMeta) {
          hasMoreClasses =
            lastPage.classMeta.page < lastPage.classMeta.totalPages;
        } else if (lastPage.programs?.some((p) => p.type === "class")) {
          const classesInLastFetch = lastPage.programs.filter(
            (p) => p.type === "class",
          ).length;
          hasMoreClasses = classesInLastFetch >= ITEMS_PER_PAGE;
        }
      }

      if (programType === "all" || programType === "webinar") {
        if (lastPage.webinarMeta) {
          hasMoreWebinars =
            lastPage.webinarMeta.page < lastPage.webinarMeta.totalPages;
        } else if (lastPage.programs?.some((p) => p.type === "webinar")) {
          const webinarsInLastFetch = lastPage.programs.filter(
            (p) => p.type === "webinar",
          ).length;
          hasMoreWebinars = webinarsInLastFetch >= ITEMS_PER_PAGE;
        }
      }

      const hasMore =
        programType === "class"
          ? hasMoreClasses
          : programType === "webinar"
            ? hasMoreWebinars
            : hasMoreClasses || hasMoreWebinars;

      return hasMore ? pages.length : undefined;
    },
    initialPageParam: 0,
    ...(seededInitialData ? { initialData: seededInitialData } : {}),
    // Mirrors useConsultants: when the query key changes (a filter, or the
    // session resolving and flipping the userId segment) keep the previous
    // rows on screen during the refetch instead of dropping to a skeleton.
    placeholderData: keepPreviousData,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
  });

  const programs = useMemo(
    () => (data ? data.pages.map((d) => d.programs).flat() : []),
    [data],
  );

  return {
    programs,
    error,
    isLoading: isLoading || isFetchingNextPage,
    hasMore: hasNextPage ?? false,
    loadMore: () => fetchNextPage(),
  };
}
