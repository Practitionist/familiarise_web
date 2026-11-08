"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  ITEMS_PER_PAGE,
  generateProgramImageUrl,
  type Program,
  type ProgramType,
  type ProgramFilters,
  type ClassPlanProgram,
  type WebinarPlanProgram,
} from "@/lib/explore/programs";
import {
  buildFilterParams,
  fetchPlans,
  type ClassPlanApiItem,
  type WebinarPlanApiItem,
} from "./_helpers";
import { useMyEventSeats } from "./useMyEventSeats";

interface UseProgramsOptions {
  userId?: string | null;
  filters?: ProgramFilters;
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
  const { userId, filters = {} } = options;
  const filterStr = buildFilterParams(filters);

  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isLoading,
    isFetchingNextPage,
    isPlaceholderData,
  } = useInfiniteQuery({
    queryKey: ["programs", programType, filterStr],
    queryFn: async ({ pageParam = 0, signal }) => {
      const requests = [];

      if (programType === "all" || programType === "class") {
        requests.push(
          `/api/plans/classes?page=${pageParam + 1}&limit=${ITEMS_PER_PAGE}&include=classes${filterStr}`,
        );
      }
      if (programType === "all" || programType === "webinar") {
        requests.push(
          `/api/plans/webinars?page=${pageParam + 1}&limit=${ITEMS_PER_PAGE}${filterStr}`,
        );
      }

      const responses = await Promise.all(
        requests.map((url) => fetchPlans(url, signal)),
      );

      let combinedPrograms: Program[] = [];
      let classMeta, webinarMeta;

      if ((programType === "all" || programType === "class") && responses[0]) {
        const classResponse = responses[0];
        classMeta = classResponse.meta;
        if (classResponse.data) {
          const formattedClasses = classResponse.data.map(
            (plan): ClassPlanProgram => {
              const typedPlan = plan as ClassPlanApiItem;

              return {
                ...typedPlan,
                classes: typedPlan.classes || [],
                type: "class",
                imageUrl: generateProgramImageUrl(typedPlan.imageUrl),
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

                return {
                  ...typedPlan,
                  webinars: typedPlan.webinars || [],
                  type: "webinar",
                  imageUrl: generateProgramImageUrl(typedPlan.imageUrl),
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
    // Keep the last results on screen while a changed search or filter loads,
    // instead of blanking the list on every keystroke burst. Not across a tab
    // change: classes must not sit under the Webinars tab while it loads.
    // Declared after `queryFn` so the page type is inferred from it.
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === programType ? previousData : undefined,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
  });

  // "Am I registered" is the viewer's own and comes from their own request, so
  // the shared list payload (and its cache) never depends on who is looking.
  const seats = useMyEventSeats(userId);
  const programs = useMemo(
    () =>
      (data ? data.pages.flatMap((d) => d.programs) : []).map(
        (program): Program => ({
          ...program,
          isRegistered: (program.type === "class"
            ? seats.classPlanIds
            : seats.webinarPlanIds
          ).has(program.id),
        }),
      ),
    [data, seats],
  );

  return {
    programs,
    error,
    isLoading: isLoading || isFetchingNextPage,
    /** Showing the previous results while a changed search or filter loads. */
    isRefreshing: isPlaceholderData,
    // Paging belongs to the results on screen, not to the ones being replaced.
    hasMore: !isPlaceholderData && (hasNextPage ?? false),
    loadMore: () => fetchNextPage(),
  };
}
