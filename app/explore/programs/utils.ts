import {
  ClassPlan as PrismaClassPlan,
  WebinarPlan as PrismaWebinarPlan,
} from "@prisma/client";

export const ITEMS_PER_PAGE = 12;

export type ProgramType = "all" | "class" | "webinar";

// Type for registration data from API
interface SlotUser {
  id: string;
}

interface SlotWithUser {
  user?: SlotUser[];
}

interface WebinarWithAppointment {
  appointment?: {
    slotsOfAppointment?: SlotWithUser[];
  } | null;
}

interface ClassSlot extends Record<string, unknown> {
  user?: SlotUser[];
}

interface ClassAppointment {
  slotsOfAppointment: ClassSlot[];
}

export interface ClassInstance {
  id: string;
  schedulingPeriodStartsAt?: string | Date | null;
  appointments?: ClassAppointment[];
}

type ProgramConsultantProfile = {
  rating?: number;
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
  webinars?: WebinarWithAppointment[];
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
}

// Generate program image URL based on ID with dimensions, using DB image if available
export function generateProgramImageUrl(
  id: string,
  width: number = 600,
  height: number = 400,
  dbImageUrl?: string | null,
): string {
  if (dbImageUrl) return dbImageUrl;
  return `https://picsum.photos/seed/${id}/${width}/${height}`;
}

export function isClassProgram(program: Program): program is ClassPlanProgram {
  return program.type === "class";
}

// Client-side filtering for search term and level only.
// Sort is handled server-side via API params — no need to re-sort here.
export function filterAndSortPrograms(
  programs: Program[],
  searchTerm: string,
  selectedLevel: string,
): Program[] {
  return programs.filter((program) => {
    const matchesSearch =
      !searchTerm ||
      program.title.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesLevel =
      selectedLevel === "all" || program.level === selectedLevel;
    return matchesSearch && matchesLevel;
  });
}

export function getUniqueLevels(programs: Program[]): string[] {
  const levels = programs
    .map((program) => program.level)
    .filter((level): level is string => level !== null);
  return Array.from(new Set(levels));
}
