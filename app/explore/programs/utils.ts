export function generateProgramImageUrl(
  id: string,
  width: number = 600,
  height: number = 400,
): string {
  // Using picsum.photos with a consistent seed based on the program ID
  return `https://picsum.photos/seed/${id}/${width}/${height}`;
}

import useSWRInfinite from "swr/infinite";
import type { TClass, TWebinar } from "@/types/appointment";

export type ProgramType = "all" | "class" | "webinar";

export type ClassProgram = TClass & {
  type: "class";
  imageUrl: string;
};

export type WebinarProgram = TWebinar & {
  type: "webinar";
  imageUrl: string;
};

export type Program = ClassProgram | WebinarProgram;

export function isClassProgram(program: Program): program is ClassProgram {
  return program.type === "class";
}

export function isWebinarProgram(program: Program): program is WebinarProgram {
  return program.type === "webinar";
}

export const ITEMS_PER_PAGE = 9;

// SWR fetcher function
const fetcher = (url: string) => fetch(url).then((res) => res.json());

export function usePrograms(programType: ProgramType) {
  const getKey = (pageIndex: number, previousPageData: any) => {
    if (previousPageData && !previousPageData.data?.length) return null;

    const requests = [];
    if (programType === "all" || programType === "class") {
      requests.push(
        `/api/events/classes?page=${pageIndex + 1}&limit=${ITEMS_PER_PAGE}`,
      );
    }
    if (programType === "all" || programType === "webinar") {
      requests.push(
        `/api/events/webinars?page=${pageIndex + 1}&limit=${ITEMS_PER_PAGE}`,
      );
    }

    return requests;
  };

  const { data, error, size, setSize, isLoading, isValidating } =
    useSWRInfinite(
      getKey,
      async (urls) => {
        const responses = await Promise.all(urls.map((url) => fetcher(url)));

        let newPrograms: Program[] = [];

        if (
          (programType === "all" || programType === "class") &&
          responses[0]
        ) {
          const formattedClasses = responses[0].data
            .filter(
              (item: TClass) =>
                item.status !== "CANCELLED" &&
                item.startDate &&
                new Date(item.startDate) >= new Date(),
            )
            .map(
              (item: TClass): ClassProgram => ({
                ...item,
                type: "class",
                imageUrl: generateProgramImageUrl(item.id),
              }),
            );
          newPrograms = [...newPrograms, ...formattedClasses];
        }

        if (
          (programType === "all" || programType === "webinar") &&
          responses[programType === "all" ? 1 : 0]
        ) {
          const formattedWebinars = responses[
            programType === "all" ? 1 : 0
          ].data
            .filter((item: TWebinar) => item.status !== "CANCELLED")
            .map(
              (item: TWebinar): WebinarProgram => ({
                ...item,
                type: "webinar",
                imageUrl: generateProgramImageUrl(item.id),
              }),
            );
          newPrograms = [...newPrograms, ...formattedWebinars];
        }

        return newPrograms;
      },
      {
        revalidateFirstPage: false,
        revalidateOnFocus: false,
      },
    );

  const programs = data ? data.flat() : [];
  const hasMore = data
    ? data[data.length - 1]?.length ===
      ITEMS_PER_PAGE * (programType === "all" ? 2 : 1)
    : true;

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
  return programs
    .filter((item) => {
      const title = isClassProgram(item)
        ? item.classPlan.title
        : item.webinarPlan.title;
      const description = isClassProgram(item)
        ? item.classPlan.description
        : item.webinarPlan.description;
      const level = isClassProgram(item)
        ? item.classPlan.level
        : item.webinarPlan.level;

      const searchMatch =
        title.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (description?.toLowerCase() || "").includes(searchTerm.toLowerCase());
      const categoryMatch =
        selectedCategory === "all" ? true : level === selectedCategory;
      return searchMatch && categoryMatch;
    })
    .sort((a, b) => {
      switch (sortBy) {
        case "price-asc":
          return (
            (isClassProgram(a) ? a.classPlan.price : a.webinarPlan.price) -
            (isClassProgram(b) ? b.classPlan.price : b.webinarPlan.price)
          );
        case "price-desc":
          return (
            (isClassProgram(b) ? b.classPlan.price : b.webinarPlan.price) -
            (isClassProgram(a) ? a.classPlan.price : a.webinarPlan.price)
          );
        case "title-asc":
          return (
            isClassProgram(a) ? a.classPlan.title : a.webinarPlan.title
          ).localeCompare(
            isClassProgram(b) ? b.classPlan.title : b.webinarPlan.title,
          );
        case "title-desc":
          return (
            isClassProgram(b) ? b.classPlan.title : b.webinarPlan.title
          ).localeCompare(
            isClassProgram(a) ? a.classPlan.title : a.webinarPlan.title,
          );
        default:
          return 0;
      }
    });
}

export function getUniqueLevels(programs: Program[]) {
  return Array.from(
    new Set(
      programs.map((program) =>
        isClassProgram(program)
          ? program.classPlan.level
          : program.webinarPlan.level,
      ),
    ),
  );
}
