"use client";

import { ScheduleType } from "@prisma/client";
import { TrashIcon } from "assets/icons";
import { Button } from "components/ui/button";
import { Input } from "components/ui/input";
import { Label } from "components/ui/label";
import { RadioGroup, RadioGroupItem } from "components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "components/ui/select";
import { Separator } from "components/ui/separator";
import { Textarea } from "components/ui/textarea";
import { useToast } from "components/ui/use-toast";
import React, { useCallback, useEffect, useState } from "react";
import { TConsultantProfile } from "types/consultant";
import { MultiSelect } from "../../components/MultiSelect";
import {
  DAYS_OF_WEEK,
  formatSlotsForApi,
  getInitialCustomSlots,
  getInitialFormData,
  getInitialWeeklySlots,
  getMonthYearString,
  type Domain,
  type FormData,
  type SlotsType,
  type SubDomain,
  type Tag,
} from "./settings";
import { useTimezone } from "@/app/explore/experts/[consultantId]/hooks/useTimezone";
// Import functions from centralized utils
import {
  formatDayDisplay,
  getDaysInMonth,
  getFirstDayOfMonth,
  getLocalDateString,
  sortSlotsByTime,
} from "@/utils/dateTimeUtils";
import {
  validateTimeSlot,
  validateAllSlotsDetailed,
} from "@/utils/timeSlotValidation";

interface Option {
  value: string;
  label: string;
}

interface SettingsTabProps {
  consultant: TConsultantProfile;
}

export function SettingsTab({ consultant }: Readonly<SettingsTabProps>) {
  const { toast } = useToast();
  const { timezone, isLoading: timezoneLoading } = useTimezone();
  const [isLoading, setIsLoading] = useState(false);
  const [isContentLoading, setIsContentLoading] = useState(true);
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

  // Initialize slots data when timezone is available
  useEffect(() => {
    if (!timezoneLoading && timezone) {
      setWeeklySlots(getInitialWeeklySlots(consultant, timezone));
      setCustomSlots(getInitialCustomSlots(consultant, timezone));
    }
  }, [consultant, timezone, timezoneLoading]);

  // Convert subdomains and tags to options format with safety checks
  const subDomainOptions = React.useMemo<Option[]>(() => {
    if (!subDomains || !Array.isArray(subDomains) || !formData.domainId) {
      return [];
    }
    return subDomains
      .filter((sd) => sd && sd.domainId === formData.domainId)
      .map((sd) => ({
        value: sd.id,
        label: sd.name,
      }));
  }, [subDomains, formData.domainId]);

  const tagOptions = React.useMemo<Option[]>(() => {
    if (!tags || !Array.isArray(tags) || !formData.domainId) {
      return [];
    }
    return tags
      .filter((tag) => tag && tag.domainId === formData.domainId)
      .map((tag) => ({
        value: tag.id,
        label: tag.name,
      }));
  }, [tags, formData.domainId]);

  // Fetch domains, subdomains, and tags
  useEffect(() => {
    const fetchData = async () => {
      try {
        setIsContentLoading(true);
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
        }
      } catch (error) {
        console.error("Error fetching data:", error);
        toast({
          title: "Error",
          description: "Failed to load domain data. Please try again.",
          variant: "destructive",
        });
      } finally {
        setIsContentLoading(false);
      }
    };

    fetchData();
  }, [toast]);

  // Update subdomains and tags when domain changes
  useEffect(() => {
    const fetchDomainContent = async () => {
      if (!formData.domainId) return;

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

    fetchDomainContent();
  }, [formData.domainId, toast]);

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleDomainChange = useCallback((value: string, e?: Event) => {
    e?.preventDefault();
    requestAnimationFrame(() => {
      setFormData((prev) => ({
        ...prev,
        domainId: value || "",
        subDomainIds: [], // Reset subdomains when domain changes
        tagIds: [], // Reset tags when domain changes
      }));
    });
  }, []);

  const handleSubDomainChange = useCallback((values: string[]) => {
    setFormData((prev) => ({
      ...prev,
      subDomainIds: values || [],
    }));
  }, []);

  const handleTagChange = useCallback((values: string[]) => {
    setFormData((prev) => ({
      ...prev,
      tagIds: values || [],
    }));
  }, []);

  // Update schedule type and clear irrelevant slots
  const handleScheduleTypeChange = useCallback((value: string) => {
    const scheduleTypeValue = value as ScheduleType;
    React.startTransition(() => {
      setScheduleType(scheduleTypeValue);
      setFormData((prev) => ({
        ...prev,
        scheduleType: scheduleTypeValue,
      }));

      // Clear slots for the inactive schedule type to prevent corruption
      if (scheduleTypeValue === ScheduleType.WEEKLY) {
        setCustomSlots({});
      } else {
        setWeeklySlots({});
      }
    });
  }, []);

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

        // Create updated slot
        const updatedSlot = {
          ...currentSlots[day][index],
          [field]: value,
        };

        // Validate the updated slot in isolation
        const validationResult = validateTimeSlot(
          updatedSlot,
          currentSlots[day]?.filter((_, i) => i !== index) || [],
          day,
          scheduleType === ScheduleType.WEEKLY,
        );

        // Handle overnight slot splitting if needed
        if (validationResult.needsSplitting) {
          setSlots((prev) => {
            const { currentDaySlot, nextDaySlot, nextKey } =
              validationResult.needsSplitting!;
            return {
              ...prev,
              [day]: [
                ...(prev[day] || []).slice(0, index),
                currentDaySlot,
                ...(prev[day] || []).slice(index + 1),
              ],
              [nextKey]: [...(prev[nextKey] || []), nextDaySlot],
            };
          });
        } else {
          // Regular slot update
          setSlots((prev) => ({
            ...prev,
            [day]: [
              ...(prev[day] || []).slice(0, index),
              validationResult.slot,
              ...(prev[day] || []).slice(index + 1),
            ],
          }));
        }
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
          if (updatedSlots[day].length === 0) {
            delete updatedSlots[day];
          }
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

  const renderCalendar = useCallback(() => {
    const daysInMonth = getDaysInMonth(currentDate);
    const firstDayOfMonth = getFirstDayOfMonth(currentDate);
    const days = [];

    // Empty cells for days before the first day of the month
    for (let i = 0; i < firstDayOfMonth; i++) {
      days.push(<div key={`empty-${i}`} className="p-2"></div>);
    }

    // Calendar days
    for (let i = 1; i <= daysInMonth; i++) {
      const date = new Date(
        currentDate.getFullYear(),
        currentDate.getMonth(),
        i,
      );
      const dateString = getLocalDateString(date);
      const isSelected = customSlots[dateString] !== undefined;

      days.push(
        <button
          key={`day-${i}`}
          type="button"
          className={`p-2 rounded-full hover:bg-gray-200
        ${isSelected ? "bg-black text-white" : ""}`}
          onClick={() => {
            React.startTransition(() => {
              setCustomSlots((prev) => {
                const newCustomSlots = { ...prev };
                if (isSelected) {
                  delete newCustomSlots[dateString];
                } else {
                  newCustomSlots[dateString] = [
                    { startTime: "", endTime: "", isValid: false },
                  ];
                }
                return newCustomSlots;
              });
            });
          }}
        >
          {i}
        </button>,
      );
    }

    return days;
  }, [currentDate, customSlots]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!consultant?.id) return;

    const currentSlots =
      scheduleType === ScheduleType.WEEKLY ? weeklySlots : customSlots;

    // Use improved validation with detailed feedback
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

    setIsLoading(true);
    try {
      // Only send slots for the current schedule type
      const updatedData = {
        ...formData,
        scheduleType,
        slotsOfAvailabilityWeekly:
          scheduleType === ScheduleType.WEEKLY
            ? formatSlotsForApi(weeklySlots, true, timezone || "UTC")
            : [],
        slotsOfAvailabilityCustom:
          scheduleType === ScheduleType.CUSTOM
            ? formatSlotsForApi(customSlots, false, timezone || "UTC")
            : [],
      };

      const response = await fetch(`/api/user/consultants/${consultant.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(updatedData),
      });

      if (!response.ok) {
        throw new Error("Failed to update settings");
      }

      // Refetch the consultant data to show what was actually saved
      const updatedResponse = await fetch(
        `/api/user/consultants/${consultant.id}`,
      );
      if (updatedResponse.ok) {
        const { data: updatedConsultant } = await updatedResponse.json();

        // Update local state to match what was saved to database
        setWeeklySlots(
          getInitialWeeklySlots(updatedConsultant, timezone || "UTC"),
        );
        setCustomSlots(
          getInitialCustomSlots(updatedConsultant, timezone || "UTC"),
        );
        setFormData(getInitialFormData(updatedConsultant));
        setScheduleType(updatedConsultant.scheduleType);
      }

      toast({
        title: "Settings updated",
        description: "Your profile settings have been successfully updated.",
      });
    } catch (error) {
      console.error("Error updating settings:", error);
      toast({
        title: "Error",
        description: "Failed to update settings. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (isContentLoading || timezoneLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-t-black border-r-black border-b-gray-200 border-l-gray-200 rounded-full animate-spin mb-4"></div>
          <p className="text-gray-500">
            {timezoneLoading ? "Detecting timezone..." : "Loading settings..."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white p-6 rounded-lg shadow space-y-8"
      role="form"
      aria-label="Settings form"
    >
      {/* Professional Profile */}
      <div>
        <h2 className="text-2xl font-bold mb-3">Professional Profile</h2>
        <p className="text-sm text-gray-600 mb-8">
          Showcase your expertise and professional background
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Left Column - Core Info */}
          <div className="space-y-6">
            <div className="bg-gray-50 p-6 rounded-lg">
              <Label className="text-lg font-semibold mb-4 block">
                Domain Expertise
              </Label>
              <div className="space-y-4">
                <div>
                  <Label className="text-sm text-gray-600">
                    Primary Domain
                  </Label>
                  <Select
                    value={formData.domainId || ""}
                    onValueChange={handleDomainChange}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select your primary domain" />
                    </SelectTrigger>
                    <SelectContent>
                      {(domains || [])
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((domain) => (
                          <SelectItem key={domain.id} value={domain.id}>
                            {domain.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label className="text-sm text-gray-600">Sub Domains</Label>
                  <div className="mt-1">
                    <MultiSelect
                      options={subDomainOptions}
                      selected={formData.subDomainIds || []}
                      onChange={handleSubDomainChange}
                      placeholder="Select relevant sub domains"
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-sm text-gray-600">
                    Expertise Tags
                  </Label>
                  <div className="mt-1">
                    <MultiSelect
                      options={tagOptions}
                      selected={formData.tagIds || []}
                      onChange={handleTagChange}
                      placeholder="Add expertise tags"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-gray-50 p-6 rounded-lg">
              <Label className="text-lg font-semibold mb-4 block">
                Professional Background
              </Label>
              <div className="space-y-4">
                <div>
                  <Label className="text-sm text-gray-600">
                    Qualifications
                  </Label>
                  <Textarea
                    name="qualifications"
                    value={formData.qualifications}
                    onChange={handleInputChange}
                    placeholder="List your degrees, certifications, and relevant qualifications"
                    className="mt-1 resize-none h-24"
                  />
                </div>

                <div>
                  <Label className="text-sm text-gray-600">
                    Specialization
                  </Label>
                  <Input
                    name="specialization"
                    value={formData.specialization}
                    onChange={handleInputChange}
                    placeholder="Your core area of expertise"
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label className="text-sm text-gray-600">
                    Years of Experience
                  </Label>
                  <Input
                    name="experience"
                    type="number"
                    min="0"
                    max="100"
                    step="0.5"
                    value={formData.experience}
                    onChange={handleInputChange}
                    placeholder="Years of experience (e.g. 5.5)"
                    className="mt-1"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Right Column - Description */}
          <div className="bg-gray-50 p-6 rounded-lg h-full">
            <Label className="text-lg font-semibold mb-4 block">
              Professional Summary
            </Label>
            <p className="text-sm text-gray-600 mb-3">
              Write a compelling description of your expertise and what makes
              you unique
            </p>
            <Textarea
              name="description"
              value={formData.description}
              onChange={handleInputChange}
              placeholder="Share your professional journey, achievements, and what clients can expect when working with you..."
              className="h-[calc(100%-6rem)] resize-none"
            />
          </div>
        </div>
      </div>

      <Separator />

      {/* Availability Settings */}
      <div>
        <h2 className="text-xl font-semibold mb-2">Availability Settings</h2>
        <p className="text-sm text-gray-500 mb-6">
          Configure your availability and scheduling preferences
        </p>

        <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <h3 className="font-medium text-blue-900 mb-2">
            📅 Schedule Type Filtering
          </h3>
          <p className="text-sm text-blue-700">
            <strong>Important:</strong> Consultees will only see slots from your
            selected schedule type. Choose "Weekly Recurring" for regular
            appointments or "Custom Schedule" for specific dates only.
          </p>
        </div>

        <RadioGroup
          value={scheduleType}
          onValueChange={handleScheduleTypeChange}
          className="flex flex-col md:flex-row md:space-x-8 space-y-4 md:space-y-0"
        >
          {/* Weekly Schedule */}
          <div className="flex-1">
            <div className="flex items-center justify-between mb-4">
              <Label htmlFor="WEEKLY" className="font-medium flex items-center">
                <span className="mr-2">📅</span>
                Weekly Recurring
                <span className="ml-2 text-xs text-gray-500">
                  (Shows recurring slots)
                </span>
              </Label>
              <RadioGroupItem id="WEEKLY" value={ScheduleType.WEEKLY} />
            </div>
            <div
              className={`space-y-4 ${scheduleType !== ScheduleType.WEEKLY ? "opacity-50 pointer-events-none" : ""}`}
            >
              {DAYS_OF_WEEK.map((day) => (
                <div key={day} className="space-y-2">
                  <div className="flex justify-between items-center">
                    <Label>{formatDayDisplay(day)}</Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleAddSlot(day.toLowerCase())}
                    >
                      Add Slot
                    </Button>
                  </div>
                  {weeklySlots[day.toLowerCase()]?.map((slot, slotIndex) => (
                    <div key={`${day}-${slotIndex}`} className="space-y-2">
                      <div className="grid grid-cols-7 gap-2 items-center">
                        <Input
                          type="time"
                          value={slot.startTime}
                          onChange={(e) =>
                            handleUpdateSlot(
                              day.toLowerCase(),
                              slotIndex,
                              "startTime",
                              e.target.value,
                            )
                          }
                          className={`col-span-3 ${!slot.isValid ? "border-red-500" : ""}`}
                          step="900"
                        />
                        <span className="text-center">to</span>
                        <Input
                          type="time"
                          value={slot.endTime}
                          onChange={(e) =>
                            handleUpdateSlot(
                              day.toLowerCase(),
                              slotIndex,
                              "endTime",
                              e.target.value,
                            )
                          }
                          className={`col-span-2 ${!slot.isValid ? "border-red-500" : ""}`}
                          step="900"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            handleDeleteSlot(day.toLowerCase(), slotIndex)
                          }
                          className="p-1 hover:bg-gray-100 rounded"
                          aria-label={`Delete slot ${slotIndex + 1} for ${day}`}
                        >
                          <TrashIcon className="w-5 h-5" />
                        </button>
                      </div>
                      {!slot.isValid && slot.errorMessage && (
                        <p className="text-red-500 text-sm">
                          {slot.errorMessage}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* Custom Schedule */}
          <div className="flex-1">
            <div className="flex items-center justify-between mb-4">
              <Label htmlFor="CUSTOM" className="font-medium flex items-center">
                <span className="mr-2">🎯</span>
                Custom Schedule
                <span className="ml-2 text-xs text-gray-500">
                  (Shows specific date slots)
                </span>
              </Label>
              <RadioGroupItem id="CUSTOM" value={ScheduleType.CUSTOM} />
            </div>
            <div
              className={`space-y-4 ${scheduleType !== ScheduleType.CUSTOM ? "opacity-50 pointer-events-none" : ""}`}
            >
              <div className="calendar-container bg-white border p-4 rounded-lg">
                <div className="flex justify-between items-center mb-4">
                  <button
                    type="button"
                    className="text-black hover:bg-gray-100 p-2 rounded-full"
                    onClick={handlePrevMonth}
                    aria-label="Previous month"
                  >
                    &larr;
                  </button>
                  <span className="font-medium">
                    {getMonthYearString(currentDate)}
                  </span>
                  <button
                    type="button"
                    className="text-black hover:bg-gray-100 p-2 rounded-full"
                    onClick={handleNextMonth}
                    aria-label="Next month"
                  >
                    &rarr;
                  </button>
                </div>
                <div className="grid grid-cols-7 gap-1 text-center">
                  {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
                    <div key={day} className="text-sm font-medium">
                      {day}
                    </div>
                  ))}
                  {renderCalendar()}
                </div>
              </div>

              {Object.keys(customSlots)
                .sort((a, b) => a.localeCompare(b))
                .map((dateString) => {
                  const date = new Date(dateString);
                  return (
                    <div key={dateString} className="space-y-2">
                      <div className="flex justify-between items-center">
                        <h4 className="font-semibold">
                          {date.toLocaleDateString("en-US", {
                            weekday: "long",
                            month: "long",
                            day: "numeric",
                          })}
                        </h4>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleAddSlot(dateString)}
                        >
                          Add Slot
                        </Button>
                      </div>
                      {customSlots[dateString]?.map((slot, slotIndex) => (
                        <div
                          key={`${dateString}-${slotIndex}`}
                          className="space-y-2"
                        >
                          <div className="grid grid-cols-7 gap-2 items-center">
                            <Input
                              type="time"
                              value={slot.startTime}
                              onChange={(e) =>
                                handleUpdateSlot(
                                  dateString,
                                  slotIndex,
                                  "startTime",
                                  e.target.value,
                                )
                              }
                              className={`col-span-3 ${!slot.isValid ? "border-red-500" : ""}`}
                              step="900"
                            />
                            <span className="text-center">to</span>
                            <Input
                              type="time"
                              value={slot.endTime}
                              onChange={(e) =>
                                handleUpdateSlot(
                                  dateString,
                                  slotIndex,
                                  "endTime",
                                  e.target.value,
                                )
                              }
                              className={`col-span-2 ${!slot.isValid ? "border-red-500" : ""}`}
                              step="900"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                handleDeleteSlot(dateString, slotIndex)
                              }
                              className="p-1 hover:bg-gray-100 rounded"
                              aria-label={`Delete slot ${slotIndex + 1} for ${dateString}`}
                            >
                              <TrashIcon className="w-5 h-5" />
                            </button>
                          </div>
                          {!slot.isValid && slot.errorMessage && (
                            <p className="text-red-500 text-sm">
                              {slot.errorMessage}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  );
                })}
            </div>
          </div>
        </RadioGroup>
      </div>

      {/* Action Buttons */}
      <div className="flex justify-end space-x-4 pt-6">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            React.startTransition(() => {
              setFormData(getInitialFormData(consultant));
              setScheduleType(consultant.scheduleType);
              setWeeklySlots(
                getInitialWeeklySlots(consultant, timezone || "UTC"),
              );
              setCustomSlots(
                getInitialCustomSlots(consultant, timezone || "UTC"),
              );
            });
          }}
          disabled={isLoading}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isLoading}>
          {isLoading ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </form>
  );
}
