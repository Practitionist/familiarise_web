import { useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  isUserEnrolled,
  isUserRegisteredForWebinar,
} from "@/lib/payments/utils/participants";
import {
  ITEMS_PER_PAGE,
  generateProgramImageUrl,
  type ApiMeta,
  type ProgramType,
  type ProgramFilters,
  type Program,
  type ClassPlanProgram,
  type WebinarPlanProgram,
  type ClassInstance,
  type TopicWithCount,
} from "./utils";

// Build query string from filter params
function buildFilterParams(filters: ProgramFilters): string {
  const params = new URLSearchParams();
  if (filters.topicIds && filters.topicIds.length > 0) {
    params.set("topicIds", filters.topicIds.join(","));
  }
  if (filters.language) params.set("language", filters.language);
  if (filters.domainId) params.set("domainId", filters.domainId);
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.minPrice !== undefined)
    params.set("minPrice", String(filters.minPrice));
  if (filters.maxPrice !== undefined)
    params.set("maxPrice", String(filters.maxPrice));
  if (filters.search) params.set("search", filters.search);
  const str = params.toString();
  return str ? `&${str}` : "";
}

type FetchJsonResponse = { data?: Array<Record<string, unknown>>; meta?: ApiMeta };

const fetchJson = (url: string): Promise<FetchJsonResponse> => fetch(url).then((res) => res.json());

interface WebinarWithAppointment {
  appointment?: {
    slotsOfAppointment?: { user?: { id: string }[] }[];
  } | null;
}

interface UseProgramsOptions {
  userId?: string | null;
  filters?: ProgramFilters;
}

export function usePrograms(
  programType: ProgramType,
  options: UseProgramsOptions = {},
) {
  const { userId, filters = {} } = options;
  const includeRegistration = !!userId;
  const filterStr = buildFilterParams(filters);

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
        requests.map((url) => fetchJson(url)),
      );

      let combinedPrograms: Program[] = [];
      let classMeta, webinarMeta;

      if ((programType === "all" || programType === "class") && responses[0]) {
        const classResponse = responses[0];
        classMeta = classResponse.meta;
        if (classResponse.data) {
          const formattedClasses = classResponse.data.map(
            (plan): ClassPlanProgram => {
              const typedPlan = plan as Record<string, unknown> & { id: string; classes?: ClassInstance[]; imageUrl?: string | null };
              const classes = (typedPlan.classes || []) as ClassInstance[];
              const appointments = classes.flatMap(
                (c) => c.appointments ?? [],
              );
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
                const typedPlan = plan as Record<string, unknown> & { id: string; webinars?: WebinarWithAppointment[]; imageUrl?: string | null };
                const webinars = (typedPlan.webinars || []) as WebinarWithAppointment[];
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
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
  });

  const programs = useMemo(
    () => (data ? data.pages.map((d) => d.programs).flat() : []),
    [data],
  );
  const hasMore = hasNextPage;

  return {
    programs,
    error,
    isLoading: isLoading || isFetchingNextPage,
    hasMore,
    loadMore: () => fetchNextPage(),
  };
}

// Hook for fetching a limited set of programs (for curated sections)
export function useCuratedPrograms(
  programType: ProgramType,
  sort: string,
  limit: number = 8,
) {
  const { data, isLoading } = useQuery({
    queryKey: ["curated-programs", programType, sort, limit],
    queryFn: async () => {
      const requests: Promise<FetchJsonResponse>[] = [];

      if (programType === "all" || programType === "class") {
        requests.push(
          fetchJson(
            `/api/plans/classes?page=1&limit=${limit}&include=classes&sort=${sort}`,
          ),
        );
      }
      if (programType === "all" || programType === "webinar") {
        requests.push(
          fetchJson(`/api/plans/webinars?page=1&limit=${limit}&sort=${sort}`),
        );
      }

      const responses = await Promise.all(requests);
      const programs: Program[] = [];

      if (
        (programType === "all" || programType === "class") &&
        responses[0]?.data
      ) {
        programs.push(
          ...responses[0].data.map(
            (plan): ClassPlanProgram => {
              const typedPlan = plan as Record<string, unknown> & { id: string; classes?: ClassInstance[]; imageUrl?: string | null };
              return {
                ...typedPlan,
                classes: (typedPlan.classes || []) as ClassInstance[],
                type: "class",
                imageUrl: generateProgramImageUrl(
                  typedPlan.id,
                  600,
                  400,
                  typedPlan.imageUrl,
                ),
              } as ClassPlanProgram;
            },
          ),
        );
      }

      const webIdx = programType === "all" ? 1 : 0;
      if (
        (programType === "all" || programType === "webinar") &&
        responses[webIdx]?.data
      ) {
        programs.push(
          ...responses[webIdx].data.map(
            (plan): WebinarPlanProgram => {
              const typedPlan = plan as Record<string, unknown> & { id: string; webinars?: WebinarWithAppointment[]; imageUrl?: string | null };
              return {
                ...typedPlan,
                webinars: (typedPlan.webinars || []) as WebinarWithAppointment[],
                type: "webinar",
                imageUrl: generateProgramImageUrl(
                  typedPlan.id,
                  600,
                  400,
                  typedPlan.imageUrl,
                ),
              } as WebinarPlanProgram;
            },
          ),
        );
      }

      // For trending, re-sort combined results; for newest, sort by createdAt
      if (sort === "newest") {
        programs.sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
      }

      return programs.slice(0, limit);
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
  });

  return { programs: data || [], isLoading };
}

// Hook for fetching topics with program counts
export function useTopicsWithCount(planType: ProgramType = "all") {
  const { data, isLoading } = useQuery({
    queryKey: ["topics-with-count", planType],
    queryFn: async () => {
      const res = await fetchJson(
        `/api/topics?withProgramCount=true&planType=${planType}`,
      );
      return (res.data || []) as unknown as TopicWithCount[];
    },
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });

  return { topics: data || [], isLoading };
}
