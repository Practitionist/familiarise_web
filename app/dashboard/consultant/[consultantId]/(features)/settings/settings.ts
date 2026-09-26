import { TConsultantProfile } from "@/types/consultant";
import {
  convertUtcToTimezone,
  extractTimeFromUtcSlot,
  sortSlotsByTime,
} from "@/utils/dateTimeUtils";
import { minuteUtcToDate } from "@/utils/scheduling-engine/slotTimeUtils";
import { isValidTimeRange } from "@/utils/scheduling-engine/interval-validation";
import type { SlotsType } from "@/utils/schedule/types";
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
  // #1703 D1/D4 — the "Booking requests" section; null cap = no limit.
  bookingMode: BookingMode;
  acceptingRequests: boolean;
  maxOpenRequests: number | null;
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
  bookingMode: consultant?.bookingMode ?? BookingMode.INSTANT,
  acceptingRequests: consultant?.acceptingRequests ?? true,
  maxOpenRequests: consultant?.maxOpenRequests ?? null,
});

/**
 * Converts a consultant's persisted weekly availability (UTC) into local-time
 * SlotType entries grouped by lowercase day-of-week key.
 */
export const getInitialWeeklySlots = (
  consultant: TConsultantProfile,
  timezone: string = "UTC",
): SlotsType => {
  if (!consultant?.availabilityWindowsWeekly?.length) return {};

  const formattedWeeklySlots: SlotsType = {};
  const refDate = new Date("1970-01-05T00:00:00Z");
  try {
    consultant.availabilityWindowsWeekly.forEach((slot) => {
      try {
        if (!slot || slot.startTimeUtc === null || slot.endTimeUtc === null) {
          console.warn("Invalid weekly slot data:", slot);
          return;
        }

        // Use the day-of-week stored in the database. This is the consultant's
        // intended day for the recurring slot. The time will be converted,
        // but the day grouping should remain consistent with the original setting.
        const day = (slot.startDay as string).toLowerCase();

        // Convert Int minutes to a temporary Date to leverage existing timezone
        // conversion, then extract local time string for display.
        const startTime = extractTimeFromUtcSlot(
          minuteUtcToDate(slot.startTimeUtc, refDate).toISOString(),
          timezone,
        );
        const endTime = extractTimeFromUtcSlot(
          minuteUtcToDate(slot.endTimeUtc, refDate).toISOString(),
          timezone,
        );

        // Only add valid slots with proper error handling
        if (isValidTimeRange(startTime, endTime)) {
          if (!formattedWeeklySlots[day]) {
            formattedWeeklySlots[day] = [];
          }
          // Preserve overnight-in-UTC flag when local times don't reflect it
          const isOvernightUTC =
            slot.startDay !== slot.endDay && startTime < endTime;
          formattedWeeklySlots[day].push({
            startTime,
            endTime,
            isValid: true,
            ...(isOvernightUTC ? { isOvernightUTC: true } : {}),
          });
        } else {
          console.warn("Invalid time range for weekly slot:", {
            day,
            startTime,
            endTime,
          });
        }
      } catch (error) {
        console.error("Error processing weekly slot:", error, slot);
      }
    });
  } catch (error) {
    console.error("Error in getInitialWeeklySlots:", error);
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

/** The query every settings section and the Requests page's paused banner share (#1703 D4). */
export const consultantSettingsQueryKey = (consultantId: string) =>
  ["consultant-settings", consultantId] as const;

/**
 * The Settings hub's sections (#1785 L-2), in the locked order. One entry is
 * one URL under `/settings/<slug>`; `group` is the titled block the left nav
 * shows it under. Settings stays ONE sidebar entry with these inside it —
 * Material's settings pattern says to group with specific titles and never to
 * split into synonyms such as "Preferences". #1527 §14 — Account leads (it
 * absorbed Security, `/profile` and change-password); "Public profile" has room
 * for Experience & education.
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
    key: "verification",
    label: "Verification",
    slug: "verification",
    description: "The documents that put the verified mark on your profile",
  },
  {
    group: "Business",
    key: "booking",
    label: "Booking requests",
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

/**
 * Retired section keys and where they live now. `security` folded into
 * Account (#1527 §14); its old `?tab=security` links and `/settings/security`
 * URL both land there.
 */
export const SETTINGS_SECTION_ALIASES: Readonly<
  Record<string, SettingsSectionKey>
> = { security: "account" };

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

/**
 * `settings?view=sections` renders the hub's section list (the mobile list
 * view, #1527) instead of redirecting to the first section.
 */
export const SETTINGS_LIST_VIEW = "sections";

/**
 * Where a legacy `settings?tab=<key>` deep link lands now that the tabs are
 * gone (#1785). Availability left Settings for the sidebar; every other key
 * is a hub section. Unknown keys and no key land on the first section.
 */
export function settingsTabRedirect(
  basePath: string,
  tab: string | null | undefined,
): string {
  if (tab === "availability") return `${basePath}/availability`;
  const key = (tab && SETTINGS_SECTION_ALIASES[tab]) ?? tab;
  const section =
    SETTINGS_SECTIONS.find((s) => s.key === key) ?? SETTINGS_SECTIONS[0];
  return settingsSectionHref(basePath, section);
}
