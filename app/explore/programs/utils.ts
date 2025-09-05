import { useInfiniteQuery } from "@tanstack/react-query";
import {
  ClassPlan as PrismaClassPlan,
  WebinarPlan as PrismaWebinarPlan,
} from "@prisma/client";

export const ITEMS_PER_PAGE = 12;

export type ProgramType = "all" | "class" | "webinar";

export type ClassPlanProgram = PrismaClassPlan & {
  classes: any[]; // Add the classes array that components expect
  type: "class";
  imageUrl: string;
};

export type WebinarPlanProgram = PrismaWebinarPlan & {
  type: "webinar";
  imageUrl: string;
};

export type Program = ClassPlanProgram | WebinarPlanProgram;

export interface ApiMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// Generate program image URL based on ID with dimensions
export function generateProgramImageUrl(
  id: string,
  width: number = 600,
  height: number = 400,
): string {
  // Using picsum.photos with a consistent seed based on the program ID
  return `https://picsum.photos/seed/${id}/${width}/${height}`;
}

export function isClassProgram(program: Program): program is ClassPlanProgram {
  return program.type === "class";
}

export function isWebinarProgram(
  program: Program,
): program is WebinarPlanProgram {
  return program.type === "webinar";
}

export function filterAndSortPrograms(
  programs: Program[],
  searchTerm: string,
  selectedCategory: string,
  sortBy: string,
): Program[] {
  let filteredPrograms = programs.filter((program) => {
    const matchesSearch = program.title
      .toLowerCase()
      .includes(searchTerm.toLowerCase());
    const matchesCategory =
      selectedCategory === "all" || program.level === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  if (sortBy === "price-asc") {
    filteredPrograms = filteredPrograms.sort((a, b) => a.price - b.price);
  } else if (sortBy === "price-desc") {
    filteredPrograms = filteredPrograms.sort((a, b) => b.price - a.price);
  } else if (sortBy === "title-asc") {
    filteredPrograms = filteredPrograms.sort((a, b) =>
      a.title.localeCompare(b.title),
    );
  } else if (sortBy === "title-desc") {
    filteredPrograms = filteredPrograms.sort((a, b) =>
      b.title.localeCompare(a.title),
    );
  }

  return filteredPrograms;
}

export function getUniqueLevels(programs: Program[]): string[] {
  const levels = programs
    .map((program) => program.level)
    .filter((level): level is string => level !== null);
  return Array.from(new Set(levels));
}

// React Query fetcher function for programs
const fetchProgramsData = (url: string) => fetch(url).then((res) => res.json());

export function usePrograms(programType: ProgramType) {
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isLoading,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["programs", programType],
    queryFn: async ({ pageParam = 0 }) => {
      const requests = [];

      if (programType === "all" || programType === "class") {
        requests.push(
          `/api/plans/classes?page=${pageParam + 1}&limit=${ITEMS_PER_PAGE}&include=classes`,
        );
      }
      if (programType === "all" || programType === "webinar") {
        requests.push(
          `/api/plans/webinars?page=${pageParam + 1}&limit=${ITEMS_PER_PAGE}`,
        );
      }

      const responses = await Promise.all(
        requests.map((url) => fetchProgramsData(url)),
      );

      let combinedPrograms: Program[] = [];
      let classMeta, webinarMeta;

      if ((programType === "all" || programType === "class") && responses[0]) {
        const classResponse = responses[0];
        classMeta = classResponse.meta;
        if (classResponse.data) {
          const formattedClasses = classResponse.data.map(
            (plan: any): ClassPlanProgram => ({
              ...plan,
              classes: plan.classes || [], // Ensure classes array is populated
              type: "class",
              imageUrl: generateProgramImageUrl(plan.id, 600, 400),
            }),
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
              (plan: PrismaWebinarPlan): WebinarPlanProgram => ({
                ...(plan as WebinarPlanProgram),
                type: "webinar",
                imageUrl: generateProgramImageUrl(plan.id, 600, 400),
              }),
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
    staleTime: 2 * 60 * 1000, // 2 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
    retry: 2,
  });

  const programs = data ? data.pages.map((d) => d.programs).flat() : [];
  const hasMore = hasNextPage;

  return {
    programs,
    error,
    isLoading: isLoading || isFetchingNextPage,
    hasMore,
    loadMore: () => fetchNextPage(),
  };
}
