import { TConsultantProfile } from "@/types/consultant";
import { convertUtcToTimezone, sortSlotsByTime } from "@/utils/dateTimeUtils";
import { minutesToTimeString } from "@/utils/scheduling-engine/slotTimeUtils";
import { hasWeeklyRowLocalColumns } from "@/utils/schedule/weekly-projection";
import { isValidTimeRange } from "@/utils/scheduling-engine/interval-validation";
import type { SlotsType } from "@/utils/schedule/types";
import { requireJsonResponse } from "@/lib/fetch-helpers";
import {
  BookingMode,
  DayOfWeek,
  ScheduleType,
  OfferingFormat,
} from "@prisma/client";

export interface FormData {
  description: string;
  experience: number;
  scheduleType: ScheduleType;
  domainId: string;
  subDomainIds: string[];
  tagIds: string[];
  // New fields
  headline: string;
  websiteUrl: string;
  twitterUrl: string;
  githubUrl: string;
  linkedinUrl: string; // Stored on User model, not ConsultantProfile
  videoIntroUrl: string;
  languages: string[];
  toolsAndTechnologies: string[];
  mentoringStyle: string;
  offeringFormats: OfferingFormat[];
}

export interface Domain {
  id: string;
  name: string;
}

export interface SubDomain {
  id: string;
  name: string;
  domainId: string;
}

export interface Tag {
  id: string;
  name: string;
  domainId: string;
}

export const DAYS_OF_WEEK: DayOfWeek[] = [
  DayOfWeek.MONDAY,
  DayOfWeek.TUESDAY,
  DayOfWeek.WEDNESDAY,
  DayOfWeek.THURSDAY,
  DayOfWeek.FRIDAY,
  DayOfWeek.SATURDAY,
  DayOfWeek.SUNDAY,
];

/** Extracts editable form fields from a consultant profile into initial form state. */
export const getInitialFormData = (
  consultant: TConsultantProfile,
): FormData => ({
  description: consultant?.description ?? "",
  experience: consultant?.experience ?? 0,
  scheduleType: consultant?.scheduleType ?? ScheduleType.WEEKLY,
  domainId: consultant?.domain?.id ?? "",
  subDomainIds: consultant?.subDomains?.map((sd) => sd.id) ?? [],
  tagIds: consultant?.tags?.map((t) => t.id) ?? [],
  // New fields
  headline: consultant?.headline ?? "",
  websiteUrl: consultant?.websiteUrl ?? "",
  twitterUrl: consultant?.twitterUrl ?? "",
  githubUrl: consultant?.githubUrl ?? "",
  linkedinUrl: consultant?.user?.linkedinUrl ?? "", // From User model
  videoIntroUrl: consultant?.videoIntroUrl ?? "",
  languages: consultant?.languages ?? [],
  toolsAndTechnologies: consultant?.toolsAndTechnologies ?? [],
  mentoringStyle: consultant?.mentoringStyle ?? "",
  offeringFormats: consultant?.offeringFormats ?? [],
});

/**
 * The zone a consultant's weekly hours are kept in: the zone their rows carry,
 * else `fallback` (the profile zone) for a schedule with no rows yet.
 */
export const weeklyScheduleZone = (
  consultant: TConsultantProfile,
  fallback: string,
): string =>
  consultant?.availabilityWindowsWeekly?.find(hasWeeklyRowLocalColumns)
    ?.timezone ?? fallback;

/**
 * A consultant's weekly rows as editable wall-clock slots, read straight from
 * their local columns and grouped by lowercase local day. Rows without local
 * columns are a data error and are left out.
 */
export const getInitialWeeklySlots = (
  consultant: TConsultantProfile,
): SlotsType => {
  if (!consultant?.availabilityWindowsWeekly?.length) return {};

  const formattedWeeklySlots: SlotsType = {};
  for (const slot of consultant.availabilityWindowsWeekly) {
    if (!slot || !hasWeeklyRowLocalColumns(slot)) {
      console.warn("Weekly slot without local columns:", slot?.id);
      continue;
    }
    const day = slot.localStartDay.toLowerCase();
    const startTime = minutesToTimeString(slot.localStartMinutes);
    const endTime = minutesToTimeString(slot.localEndMinutes);
    if (!isValidTimeRange(startTime, endTime)) {
      console.warn("Invalid time range for weekly slot:", {
        day,
        startTime,
        endTime,
      });
      continue;
    }
    // Preserve the overnight-in-UTC hint when the local times don't show it.
    const isOvernightUTC = slot.startDay !== slot.endDay && startTime < endTime;
    const daySlots = formattedWeeklySlots[day] ?? [];
    daySlots.push({
      startTime,
      endTime,
      isValid: true,
      ...(isOvernightUTC ? { isOvernightUTC: true } : {}),
    });
    formattedWeeklySlots[day] = daySlots;
  }

  // Sort slots chronologically within each day
  Object.keys(formattedWeeklySlots).forEach((day) => {
    formattedWeeklySlots[day] = sortSlotsByTime(formattedWeeklySlots[day]);
  });

  return formattedWeeklySlots;
};

/**
 * Converts a consultant's persisted custom availability (UTC) into local-time
 * SlotType entries grouped by YYYY-MM-DD date key.
 */
export const getInitialCustomSlots = (
  consultant: TConsultantProfile,
  timezone: string = "UTC",
): SlotsType => {
  if (!consultant?.availabilityWindowsCustom?.length) return {};

  const formattedCustomSlots: SlotsType = {};
  try {
    consultant.availabilityWindowsCustom.forEach((slot) => {
      try {
        if (!slot || !slot.startsAt || !slot.endsAt) {
          console.warn("Invalid custom slot data:", slot);
          return;
        }

        const startDate = new Date(slot.startsAt);
        const endDate = new Date(slot.endsAt);

        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
          console.warn(
            "Invalid date in custom slot:",
            slot.startsAt,
            slot.endsAt,
          );
          return;
        }

        // For custom slots, use timezone-aware conversion
        // Get the date in the specified timezone
        const dateString = startDate.toLocaleDateString("en-CA", {
          timeZone: timezone,
        }); // en-CA gives YYYY-MM-DD format

        const startTime = convertUtcToTimezone(
          slot.startsAt.toString(),
          timezone,
        );
        const endTime = convertUtcToTimezone(slot.endsAt.toString(), timezone);

        // Only add valid slots with proper error handling
        if (isValidTimeRange(startTime, endTime)) {
          if (!formattedCustomSlots[dateString]) {
            formattedCustomSlots[dateString] = [];
          }
          formattedCustomSlots[dateString].push({
            startTime,
            endTime,
            isValid: true,
          });
        } else {
          console.warn("Invalid time range for custom slot:", {
            dateString,
            startTime,
            endTime,
          });
        }
      } catch (error) {
        console.error("Error processing custom slot:", error, slot);
      }
    });
  } catch (error) {
    console.error("Error in getInitialCustomSlots:", error);
  }

  // Sort slots chronologically within each date
  Object.keys(formattedCustomSlots).forEach((dateString) => {
    formattedCustomSlots[dateString] = sortSlotsByTime(
      formattedCustomSlots[dateString],
    );
  });

  return formattedCustomSlots;
};

/** Returns a human-readable "Month Year" string (e.g., "January 2025") for the calendar header. */
export const getMonthYearString = (date: Date) => {
  return date.toLocaleString("default", {
    month: "long",
    year: "numeric",
  });
};

/** The query every settings section and the Requests page's paused banner share. */
export const consultantSettingsQueryKey = (consultantId: string) =>
  ["consultant-settings", consultantId] as const;

/** The "Booking mode" settings; a null cap means no limit. */
export interface BookingRequestSettings {
  bookingMode: BookingMode;
  acceptingRequests: boolean;
  maxOpenRequests: number | null;
  /** The most live 1:1 plan clients at once; null means no limit. */
  maxActivePlanClients: number | null;
}

/** The profile's booking settings, with the schema defaults when absent. */
export const getInitialBookingRequestSettings = (
  consultant: TConsultantProfile,
): BookingRequestSettings => ({
  bookingMode: consultant?.bookingMode ?? BookingMode.INSTANT,
  acceptingRequests: consultant?.acceptingRequests ?? true,
  maxOpenRequests: consultant?.maxOpenRequests ?? null,
  maxActivePlanClients: consultant?.maxActivePlanClients ?? null,
});

/** Only the fields the user changed, each with the value the screen showed. */
export interface BookingRequestSettingsChange {
  set: Partial<BookingRequestSettings>;
  expect: Partial<BookingRequestSettings>;
}

/** The change from `shown` to `next`, or null when nothing changed. */
export function bookingRequestSettingsChange(
  shown: BookingRequestSettings,
  next: BookingRequestSettings,
): BookingRequestSettingsChange | null {
  const change: BookingRequestSettingsChange = { set: {}, expect: {} };
  if (shown.bookingMode !== next.bookingMode) {
    change.set.bookingMode = next.bookingMode;
    change.expect.bookingMode = shown.bookingMode;
  }
  if (shown.acceptingRequests !== next.acceptingRequests) {
    change.set.acceptingRequests = next.acceptingRequests;
    change.expect.acceptingRequests = shown.acceptingRequests;
  }
  if (shown.maxOpenRequests !== next.maxOpenRequests) {
    change.set.maxOpenRequests = next.maxOpenRequests;
    change.expect.maxOpenRequests = shown.maxOpenRequests;
  }
  if (shown.maxActivePlanClients !== next.maxActivePlanClients) {
    change.set.maxActivePlanClients = next.maxActivePlanClients;
    change.expect.maxActivePlanClients = shown.maxActivePlanClients;
  }
  return Object.keys(change.set).length > 0 ? change : null;
}

/**
 * Saves the Booking mode settings through their own PATCH, the only
 * writer of them. Throws the server's refusal (409 SETTINGS_CHANGED when they
 * changed elsewhere since the screen was drawn) for the caller's toast.
 */
export async function saveBookingRequestSettings(
  consultantId: string,
  change: BookingRequestSettingsChange,
): Promise<BookingRequestSettings> {
  const res = await fetch(`/api/user/consultants/${consultantId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(change),
  });
  const { data } = (await requireJsonResponse(
    res,
    "Couldn't save your booking settings",
  )) as { data: BookingRequestSettings };
  return data;
}

/**
 * The Settings hub's sections in the locked order. One entry is
 * one URL under `/settings/<slug>`; `group` is the titled block the left nav
 * shows it under. Settings stays ONE sidebar entry with these inside it —
 * Material's settings pattern says to group with specific titles and never to
 * split into synonyms such as "Preferences". Account leads (security, password
 * and sessions); "Public profile" has room for Experience & education.
 */
export interface SettingsSection {
  group: string;
  key: SettingsSectionKey;
  label: string;
  slug: string;
  description: string;
}

export type SettingsSectionKey =
  | "account"
  | "notifications"
  | "profile"
  | "experience"
  | "verification"
  | "booking"
  | "get-paid";

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    group: "Account",
    key: "account",
    label: "Account",
    slug: "account",
    description:
      "Your details, password, sessions, connected accounts and data rights",
  },
  {
    group: "Account",
    key: "notifications",
    label: "Notifications",
    slug: "notifications",
    description: "Which updates reach you, and on which channel",
  },
  {
    group: "Public profile",
    key: "profile",
    label: "Profile",
    slug: "profile",
    description: "Your expertise, background and the links on your public page",
  },
  {
    group: "Public profile",
    key: "experience",
    label: "Experience & education",
    slug: "experience",
    description:
      "Work history, education, certifications and achievements on your page",
  },
  {
    group: "Public profile",
    key: "verification",
    label: "Verification",
    slug: "verification",
    description: "The documents that put the verified mark on your profile",
  },
  {
    group: "Business",
    key: "booking",
    label: "Booking mode",
    slug: "booking",
    description:
      "Whether people book you instantly or ask first, and how many can wait",
  },
  {
    group: "Business",
    key: "get-paid",
    label: "Get paid",
    slug: "get-paid",
    description:
      "Where your earnings go, and the tax details the law asks us to hold",
  },
];

/** The sections in nav order, grouped under their titles. */
export function settingsSectionGroups(): {
  title: string;
  sections: SettingsSection[];
}[] {
  const groups: { title: string; sections: SettingsSection[] }[] = [];
  for (const section of SETTINGS_SECTIONS) {
    const last = groups[groups.length - 1];
    if (last?.title === section.group) {
      last.sections.push(section);
    } else {
      groups.push({ title: section.group, sections: [section] });
    }
  }
  return groups;
}

/** `/dashboard/consultant/<id>/settings/<slug>` for a section. */
export function settingsSectionHref(
  basePath: string,
  section: Pick<SettingsSection, "slug">,
): string {
  return `${basePath}/settings/${section.slug}`;
}
