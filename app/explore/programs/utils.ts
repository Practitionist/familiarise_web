export function generateProgramImageUrl(
  id: string,
  width: number = 600,
  height: number = 400,
): string {
  // Using picsum.photos with a consistent seed based on the program ID
  return `https://picsum.photos/seed/${id}/${width}/${height}`;
}

import useSWRInfinite from "swr/infinite";
import type { Prisma, ClassPlan as PrismaClassPlan, WebinarPlan as PrismaWebinarPlan, Topic, ClassContent, Class as PrismaClass } from "@prisma/client";

export type ProgramType = "all" | "class" | "webinar";

export type ApiMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export type ClassPlanProgram = PrismaClassPlan & {
  classContents: ClassContent[];
  consultantProfile?: Prisma.ConsultantProfileGetPayload<{ include: { user: { select: { id: true, name: true, image: true } } } }> | null;
  topics: Topic[];
  classes: PrismaClass[];
  type: "class";
  imageUrl: string;
};

export type WebinarPlanProgram = PrismaWebinarPlan & {
  consultantProfile?: Prisma.ConsultantProfileGetPayload<{ include: { user: { select: { id: true, name: true, image: true } } } }> | null;
  topics: Topic[];
  type: "webinar";
  imageUrl: string;
};

export type Program = ClassPlanProgram | WebinarPlanProgram;

export function isClassProgram(program: Program): program is ClassPlanProgram {
  return program.type === "class";
}

export function isWebinarProgram(program: Program): program is WebinarPlanProgram {
  return program.type === "webinar";
}

export const ITEMS_PER_PAGE = 9;

// SWR fetcher function
const fetcher = (url: string) => fetch(url).then((res) => res.json());

export function usePrograms(programType: ProgramType) {
  const getKey = (
    pageIndex: number,
    previousPageData: { programs: Program[]; classMeta?: ApiMeta; webinarMeta?: ApiMeta } | null,
  ) => {
    if (pageIndex > 0 && previousPageData && !previousPageData.programs?.length) {
      // If it's not the first fetch (pageIndex > 0) and the last fetch returned no programs
      let noMoreClassPages = true;
      let noMoreWebinarPages = true;

      if (programType === 'all' || programType === 'class') {
        noMoreClassPages = previousPageData.classMeta ? previousPageData.classMeta.page >= previousPageData.classMeta.totalPages : true;
      }
      if (programType === 'all' || programType === 'webinar') {
        noMoreWebinarPages = previousPageData.webinarMeta ? previousPageData.webinarMeta.page >= previousPageData.webinarMeta.totalPages : true;
      }

      if (programType === 'class' && noMoreClassPages) return null;
      if (programType === 'webinar' && noMoreWebinarPages) return null;
      if (programType === 'all' && noMoreClassPages && noMoreWebinarPages) return null;
    }
    // Special case: if total items are 0, totalPages might be 0. First fetch (pageIndex=0) should still proceed.
    // If previousPageData exists (so it's not the first call to getKey for SWR's setup) and meta indicates 0 total items for a type, stop for that type.
    if (previousPageData) {
        if (programType === 'class' && previousPageData.classMeta && previousPageData.classMeta.total === 0 && previousPageData.classMeta.totalPages === 0) return null;
        if (programType === 'webinar' && previousPageData.webinarMeta && previousPageData.webinarMeta.total === 0 && previousPageData.webinarMeta.totalPages === 0) return null;
        if (programType === 'all' && 
            previousPageData.classMeta && previousPageData.classMeta.total === 0 && previousPageData.classMeta.totalPages === 0 &&
            previousPageData.webinarMeta && previousPageData.webinarMeta.total === 0 && previousPageData.webinarMeta.totalPages === 0) return null;
    }

    const requests = [];
    if (programType === "all" || programType === "class") {
      requests.push(
        `/api/plans/classes?page=${pageIndex + 1}&limit=${ITEMS_PER_PAGE}`,
      );
    }
    if (programType === "all" || programType === "webinar") {
      requests.push(
        `/api/plans/webinars?page=${pageIndex + 1}&limit=${ITEMS_PER_PAGE}`,
      );
    }

    return requests;
  };

  const { data, error, size, setSize, isLoading, isValidating } =
    useSWRInfinite(
      getKey,
      async (urls) => {
        const responses = await Promise.all(urls.map((url) => fetcher(url)));
        // fetcher returns { data: any[], meta: { page: number, totalPages: number, ... } }

        let combinedPrograms: Program[] = [];
        let classMeta, webinarMeta;

        if ((programType === "all" || programType === "class") && responses[0]) {
          const classResponse = responses[0];
          classMeta = classResponse.meta;
          if (classResponse.data) {
            const formattedClasses = classResponse.data.map(
              (plan: PrismaClassPlan): ClassPlanProgram => ({
                ...(plan as ClassPlanProgram),
                type: "class",
                imageUrl: generateProgramImageUrl(plan.id),
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
                  imageUrl: generateProgramImageUrl(plan.id),
                }),
              );
              combinedPrograms = [...combinedPrograms, ...formattedWebinars];
            }
          }
        }
        return { programs: combinedPrograms, classMeta, webinarMeta };
      },
      {
        revalidateFirstPage: false,
        revalidateOnFocus: false,
      },
    );

  const programs = data ? data.map(d => d.programs).flat() : [];

  const lastPageData = data ? data[data.length - 1] : null;
  let hasMoreClasses = false;
  let hasMoreWebinars = false;

  if (lastPageData) {
    if (programType === "all" || programType === "class") {
      if (lastPageData.classMeta) {
        hasMoreClasses = lastPageData.classMeta.page < lastPageData.classMeta.totalPages;
      } else if (lastPageData.programs?.some(p => p.type === 'class')) {
        // Fallback if meta is missing but we received classes
        const classesInLastFetch = lastPageData.programs.filter(p => p.type === 'class').length;
        hasMoreClasses = classesInLastFetch >= ITEMS_PER_PAGE; // True if full page or more
      }
    }
    if (programType === "all" || programType === "webinar") {
      if (lastPageData.webinarMeta) {
        hasMoreWebinars = lastPageData.webinarMeta.page < lastPageData.webinarMeta.totalPages;
      } else if (lastPageData.programs?.some(p => p.type === 'webinar')) {
        // Fallback if meta is missing but we received webinars
        const webinarsInLastFetch = lastPageData.programs.filter(p => p.type === 'webinar').length;
        hasMoreWebinars = webinarsInLastFetch >= ITEMS_PER_PAGE; // True if full page or more
      }
    }
  } else {
    // If no data has been loaded yet, assume there's more, unless specific type is chosen and has no items initially
    hasMoreClasses = (programType === "all" || programType === "class");
    hasMoreWebinars = (programType === "all" || programType === "webinar");
  }
  
  const hasMore = (programType === "class") ? hasMoreClasses :
                  (programType === "webinar") ? hasMoreWebinars :
                  (hasMoreClasses || hasMoreWebinars);

  return {
    programs,
    error,
    isLoading: isLoading || isValidating,
    hasMore,
    loadMore: () => setSize(size + 1),
  };
}

export function filterAndSortPrograms(
  programs: Program[],
  searchTerm: string,
  selectedCategory: string,
  sortBy: string,
) {
  const filteredPrograms = programs.filter((item: Program) => {
    const title = item.title;
    const description = item.description;
    const level = item.level;

    const searchMatch =
      title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (description?.toLowerCase() ?? "").includes(searchTerm.toLowerCase());
    const categoryMatch =
      selectedCategory === "all" ? true : level === selectedCategory;
    return searchMatch && categoryMatch;
  });

  const sortedPrograms = filteredPrograms.sort((a: Program, b: Program) => {
    switch (sortBy) {
      case "date": {
        const dateA = new Date(a.createdAt).getTime();
        const dateB = new Date(b.createdAt).getTime();
        return dateB - dateA;
      }
      case "price-asc":
        return a.price - b.price;
      case "price-desc":
        return b.price - a.price;
      case "title-asc":
        return a.title.localeCompare(b.title);
      case "title-desc":
        return b.title.localeCompare(a.title);
      default:
        return 0;
    }
  });

  return sortedPrograms;
}

export function getUniqueLevels(programs: Program[]) {
  return Array.from(
    new Set(programs.map((program: Program) => program.level)),
  ).filter(level => level != null) as string[];
}
