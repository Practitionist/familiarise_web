"use client";

import { ScheduleType } from "@prisma/client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "components/ui/use-toast";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { TConsultantProfile } from "types/consultant";
import { useTimezone } from "@/app/explore/experts/[consultantId]/hooks/useTimezone";
import {
  validateTimeSlot,
  validateAllSlotsDetailed,
} from "@/utils/scheduling-engine/interval-validation";
import { formatSlotsForApi } from "@/utils/schedule/formatting";
import { reportSentryError } from "@/lib/observability/report";
import {
  isExpectedRefusal,
  userMessageFrom,
} from "@/lib/errors/client-refusal";
import { requireJsonResponse } from "@/lib/fetch-helpers";
import type { SlotsType } from "@/utils/schedule/types";
import {
  getInitialCustomSlots,
  getInitialFormData,
  getInitialWeeklySlots,
  type Domain,
  type FormData,
  type SubDomain,
  type Tag,
} from "./settings";
import type { Option } from "./sections/ProfileSection";

/**
 * Which extra reads a section needs on top of the profile it was given.
 * `content` is the domain/sub-domain/tag lists the Profile section renders;
 * `scheduleSwitch` is the WEEKLY↔CUSTOM lock the Availability page shows.
 */
export interface SettingsFormOptions {
  content?: boolean;
  scheduleSwitch?: boolean;
}

/**
 * The one form behind Profile, Availability and Booking requests (#1785).
 *
 * The three sections used to be tabs of a single component and are now three
 * pages, but the save contract did not move: `PUT /api/user/consultants/[id]`
 * is a strict schema that wants the whole profile plus the active schedule's
 * slots on every call. Each page therefore holds the FULL form state seeded
 * from the profile, shows only its own fields, and sends the same payload the
 * tabbed form sent — a save from Availability carries the untouched profile
 * fields, and a save from Profile carries the untouched slots.
 */
export function useConsultantSettingsForm(
  consultant: TConsultantProfile,
  { content = false, scheduleSwitch = false }: SettingsFormOptions = {},
) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { timezone, isLoading: timezoneLoading } = useTimezone();
  const [isSaving, setIsSaving] = useState(false);
  const [isContentLoading, setIsContentLoading] = useState(content);
  const [contentError, setContentError] = useState(false);
  const [weeklySlots, setWeeklySlots] = useState<SlotsType>({});
  const [customSlots, setCustomSlots] = useState<SlotsType>({});
  const [currentDate, setCurrentDate] = useState(new Date());
  const [scheduleType, setScheduleType] = useState<ScheduleType>(
    consultant.scheduleType,
  );
  const [formData, setFormData] = useState<FormData>(
    getInitialFormData(consultant),
  );
  const [domains, setDomains] = useState<Domain[]>([]);
  const [subDomains, setSubDomains] = useState<SubDomain[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [canSwitchSchedule, setCanSwitchSchedule] = useState(true);
  const [scheduleSwitchBlockedReason, setScheduleSwitchBlockedReason] =
    useState<string | null>(null);

  // Slots are stored in UTC and edited in the consultant's zone.
  useEffect(() => {
    if (!timezoneLoading && timezone) {
      setWeeklySlots(getInitialWeeklySlots(consultant, timezone));
      setCustomSlots(getInitialCustomSlots(consultant, timezone));
    }
  }, [consultant, timezone, timezoneLoading]);

  useEffect(() => {
    if (!scheduleSwitch) return;
    async function checkScheduleSwitchEligibility() {
      try {
        const res = await fetch(
          `/api/user/consultants/${consultant.id}/can-switch-schedule`,
        );
        const data = await res.json();
        setCanSwitchSchedule(data.canSwitch);
        setScheduleSwitchBlockedReason(
          data.canSwitch ? null : data.details || data.reason,
        );
      } catch (error) {
        console.error("Error checking schedule switch eligibility:", error);
        // On error, allow switching (the route validates anyway).
        setCanSwitchSchedule(true);
      }
    }
    void checkScheduleSwitchEligibility();
  }, [consultant.id, scheduleSwitch]);

  const subDomainOptions = useMemo<Option[]>(() => {
    if (!Array.isArray(subDomains) || !formData.domainId) return [];
    return subDomains
      .filter((sd) => sd && sd.domainId === formData.domainId)
      .map((sd) => ({ value: sd.id, label: sd.name }));
  }, [subDomains, formData.domainId]);

  const tagOptions = useMemo<Option[]>(() => {
    if (!Array.isArray(tags) || !formData.domainId) return [];
    return tags
      .filter((tag) => tag && tag.domainId === formData.domainId)
      .map((tag) => ({ value: tag.id, label: tag.name }));
  }, [tags, formData.domainId]);

  const fetchContentData = useCallback(async () => {
    try {
      setIsContentLoading(true);
      setContentError(false);
      const [domainsRes, subDomainsRes, tagsRes] = await Promise.all([
        fetch("/api/user/content/domains"),
        fetch("/api/user/content/subdomains"),
        fetch("/api/user/content/tags"),
      ]);
      if (domainsRes.ok && subDomainsRes.ok && tagsRes.ok) {
        const [domainsData, subDomainsData, tagsData] = await Promise.all([
          domainsRes.json(),
          subDomainsRes.json(),
          tagsRes.json(),
        ]);
        setDomains(domainsData || []);
        setSubDomains(subDomainsData || []);
        setTags(tagsData || []);
      } else {
        setContentError(true);
      }
    } catch (error) {
      console.error("Error fetching data:", error);
      setContentError(true);
    } finally {
      setIsContentLoading(false);
    }
  }, []);

  useEffect(() => {
    if (content) void fetchContentData();
  }, [content, fetchContentData]);

  // Sub-domains and tags narrow to the chosen domain.
  useEffect(() => {
    if (!content || !formData.domainId) return;
    const fetchDomainContent = async () => {
      try {
        setIsContentLoading(true);
        const [subDomainsRes, tagsRes] = await Promise.all([
          fetch(`/api/user/content/subdomains?domainId=${formData.domainId}`),
          fetch(`/api/user/content/tags?domainId=${formData.domainId}`),
        ]);
        if (subDomainsRes.ok && tagsRes.ok) {
          const [subDomainsData, tagsData] = await Promise.all([
            subDomainsRes.json(),
            tagsRes.json(),
          ]);
          setSubDomains(subDomainsData || []);
          setTags(tagsData || []);
        }
      } catch (error) {
        console.error("Error fetching domain content:", error);
        toast({
          title: "Error",
          description: "Failed to load domain content. Please try again.",
          variant: "destructive",
        });
      } finally {
        setIsContentLoading(false);
      }
    };
    void fetchDomainContent();
  }, [content, formData.domainId, toast]);

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleDomainChange = useCallback((value: string, e?: Event) => {
    e?.preventDefault();
    requestAnimationFrame(() => {
      setFormData((prev) => ({
        ...prev,
        domainId: value || "",
        subDomainIds: [],
        tagIds: [],
      }));
    });
  }, []);

  const handleSubDomainChange = useCallback((values: string[]) => {
    setFormData((prev) => ({ ...prev, subDomainIds: values || [] }));
  }, []);

  const handleTagChange = useCallback((values: string[]) => {
    setFormData((prev) => ({ ...prev, tagIds: values || [] }));
  }, []);

  const handleScheduleTypeChange = useCallback(
    (value: string) => {
      const scheduleTypeValue = value as ScheduleType;
      if (!canSwitchSchedule && scheduleTypeValue !== scheduleType) {
        toast({
          title: "Cannot Switch Schedule Type",
          description:
            scheduleSwitchBlockedReason ||
            "You have active appointments. Please complete or cancel them first.",
          variant: "destructive",
        });
        return;
      }
      React.startTransition(() => {
        setScheduleType(scheduleTypeValue);
        setFormData((prev) => ({ ...prev, scheduleType: scheduleTypeValue }));
        // Clear the inactive type's slots so they can't leak into the payload.
        if (scheduleTypeValue === ScheduleType.WEEKLY) {
          setCustomSlots({});
        } else {
          setWeeklySlots({});
        }
      });
    },
    [canSwitchSchedule, scheduleType, scheduleSwitchBlockedReason, toast],
  );

  const handleAddSlot = useCallback(
    (day: string) => {
      React.startTransition(() => {
        const updateSlots = (prev: SlotsType) => ({
          ...prev,
          [day]: [
            ...(prev[day] || []),
            { startTime: "", endTime: "", isValid: false },
          ],
        });
        if (scheduleType === ScheduleType.WEEKLY) {
          setWeeklySlots(updateSlots);
        } else {
          setCustomSlots(updateSlots);
        }
      });
    },
    [scheduleType],
  );

  const handleUpdateSlot = useCallback(
    (
      day: string,
      index: number,
      field: "startTime" | "endTime",
      value: string,
    ) => {
      React.startTransition(() => {
        const currentSlots =
          scheduleType === ScheduleType.WEEKLY ? weeklySlots : customSlots;
        const setSlots =
          scheduleType === ScheduleType.WEEKLY
            ? setWeeklySlots
            : setCustomSlots;
        const updatedSlot = { ...currentSlots[day][index], [field]: value };
        const validationResult = validateTimeSlot(
          updatedSlot,
          currentSlots[day]?.filter((_, i) => i !== index) || [],
        );
        setSlots((prev) => ({
          ...prev,
          [day]: [
            ...(prev[day] || []).slice(0, index),
            validationResult,
            ...(prev[day] || []).slice(index + 1),
          ],
        }));
      });
    },
    [scheduleType, weeklySlots, customSlots],
  );

  const handleDeleteSlot = useCallback(
    (day: string, index: number) => {
      React.startTransition(() => {
        const deleteSlot = (prev: SlotsType) => {
          const updatedSlots = {
            ...prev,
            [day]: prev[day].filter((_, i) => i !== index),
          };
          if (updatedSlots[day].length === 0) delete updatedSlots[day];
          return updatedSlots;
        };
        if (scheduleType === ScheduleType.WEEKLY) {
          setWeeklySlots(deleteSlot);
        } else {
          setCustomSlots(deleteSlot);
        }
      });
    },
    [scheduleType],
  );

  const handlePrevMonth = useCallback(() => {
    setCurrentDate(
      (prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1),
    );
  }, []);

  const handleNextMonth = useCallback(() => {
    setCurrentDate(
      (prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1),
    );
  }, []);

  const handleToggleCustomDate = useCallback(
    (dateString: string, isSelected: boolean) => {
      React.startTransition(() => {
        setCustomSlots((prev) => {
          const next = { ...prev };
          if (isSelected) {
            delete next[dateString];
          } else {
            next[dateString] = [{ startTime: "", endTime: "", isValid: false }];
          }
          return next;
        });
      });
    },
    [],
  );

  const reset = useCallback(() => {
    React.startTransition(() => {
      setFormData(getInitialFormData(consultant));
      setScheduleType(consultant.scheduleType);
      setWeeklySlots(getInitialWeeklySlots(consultant, timezone || "UTC"));
      setCustomSlots(getInitialCustomSlots(consultant, timezone || "UTC"));
    });
  }, [consultant, timezone]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!consultant?.id) return;

    const currentSlots =
      scheduleType === ScheduleType.WEEKLY ? weeklySlots : customSlots;
    const validation = validateAllSlotsDetailed(currentSlots);
    if (!validation.isValid) {
      const errorMessage =
        validation.errors.length > 0
          ? `Please fix the following issues:\n${validation.errors.slice(0, 3).join("\n")}${validation.errors.length > 3 ? "\n...and more" : ""}`
          : "Please ensure all time slots are valid before saving.";
      toast({
        title: "Validation Error",
        description: errorMessage,
        variant: "destructive",
      });
      return;
    }
    if (!formData.domainId) {
      toast({
        title: "Validation Error",
        description: "Please select a domain before saving.",
        variant: "destructive",
      });
      return;
    }

    setIsSaving(true);
    try {
      const updatedData = {
        ...formData,
        scheduleType,
        availabilityWindowsWeekly:
          scheduleType === ScheduleType.WEEKLY
            ? formatSlotsForApi(weeklySlots, true, timezone || "UTC")
            : [],
        availabilityWindowsCustom:
          scheduleType === ScheduleType.CUSTOM
            ? formatSlotsForApi(customSlots, false, timezone || "UTC")
            : [],
        headline: formData.headline || null,
        websiteUrl: formData.websiteUrl || null,
        twitterUrl: formData.twitterUrl || null,
        githubUrl: formData.githubUrl || null,
        linkedinUrl: formData.linkedinUrl || null,
        videoIntroUrl: formData.videoIntroUrl || null,
        languages: formData.languages || [],
        toolsAndTechnologies: formData.toolsAndTechnologies || [],
        mentoringStyle: formData.mentoringStyle || null,
        offeringFormats: formData.offeringFormats || [],
      };

      const response = await fetch(`/api/user/consultants/${consultant.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatedData),
      });

      // The route answers validation refusals as 400s with a sentence; dropping
      // the body turned each into a captured fault and a blank toast (FAMILIARISE_WEB-2T).
      const saved = (await requireJsonResponse(
        response,
        "Failed to update settings",
      )) as {
        uncoveredUpcoming?: { count: number; appointmentIds: string[] };
      };

      const updatedResponse = await fetch(
        `/api/user/consultants/${consultant.id}`,
      );
      if (updatedResponse.ok) {
        const { data: updatedConsultant } = await updatedResponse.json();
        setWeeklySlots(
          getInitialWeeklySlots(updatedConsultant, timezone || "UTC"),
        );
        setCustomSlots(
          getInitialCustomSlots(updatedConsultant, timezone || "UTC"),
        );
        setFormData(getInitialFormData(updatedConsultant));
        setScheduleType(updatedConsultant.scheduleType);
      }

      // #1703 D4 — the Requests page reads the same query for its paused banner.
      await queryClient.invalidateQueries({
        queryKey: ["consultant-settings", consultant.id],
      });

      // A booking keeps its time when the hours shrink; say how many sit
      // outside the new hours instead of refusing (docs/onboarding/03-availability-contract.md).
      const uncovered = saved.uncoveredUpcoming?.count ?? 0;
      toast({
        title: "Settings updated",
        description:
          uncovered > 0
            ? `Saved. ${uncovered} upcoming ${uncovered === 1 ? "session now falls" : "sessions now fall"} outside your published hours — they keep their time; reschedule or cancel from Appointments if needed.`
            : "Your profile settings have been successfully updated.",
      });
    } catch (error) {
      // formatSlotsForApi throws rather than degrading, so a slot-formatting
      // regression lands here instead of shipping a short payload (#1125).
      if (!isExpectedRefusal(error)) {
        reportSentryError(error, {
          subsystem: "consultants",
          op: "SettingsTab.save",
          extra: { consultantId: consultant.id, scheduleType },
        });
      }
      console.error("Error updating settings:", error);
      toast({
        title: "Error",
        description: isExpectedRefusal(error)
          ? userMessageFrom(error)
          : "Failed to update settings. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return {
    timezoneLoading,
    isSaving,
    isContentLoading,
    contentError,
    fetchContentData,
    formData,
    setFormData,
    domains,
    subDomainOptions,
    tagOptions,
    scheduleType,
    canSwitchSchedule,
    scheduleSwitchBlockedReason,
    weeklySlots,
    customSlots,
    currentDate,
    handleInputChange,
    handleDomainChange,
    handleSubDomainChange,
    handleTagChange,
    handleScheduleTypeChange,
    handleAddSlot,
    handleUpdateSlot,
    handleDeleteSlot,
    handlePrevMonth,
    handleNextMonth,
    handleToggleCustomDate,
    handleSubmit,
    reset,
  };
}
