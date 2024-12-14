"use client";

import React, { useState, useCallback, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScheduleType } from "@prisma/client";
import { TConsultantProfile } from "@/types/consultant";
import { useToast } from "@/components/ui/use-toast";
import { TrashIcon } from "@/assets/icons";
import { MultiSelect, type Option } from "../components/MultiSelect";
import {
  DAYS_OF_WEEK,
  formatDayDisplay,
  getInitialFormData,
  getInitialWeeklySlots,
  getInitialCustomSlots,
  getInitialServiceSettings,
  validateSlot,
  validateAllSlots,
  getDaysInMonth,
  getFirstDayOfMonth,
  getMonthYearString,
  getLocalDateString,
  formatSlotsForApi,
  type FormData,
  type SlotType,
  type SlotsType,
  type ServiceSettings,
  type Domain,
  type SubDomain,
  type Tag,
} from "../settings";

interface SettingsTabProps {
  consultant: TConsultantProfile;
}

export function SettingsTab({ consultant }: SettingsTabProps) {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [isContentLoading, setIsContentLoading] = useState(true);
  const [weeklySlots, setWeeklySlots] = useState<SlotsType>(
    getInitialWeeklySlots(consultant),
  );
  const [customSlots, setCustomSlots] = useState<SlotsType>(
    getInitialCustomSlots(consultant),
  );
  const [currentDate, setCurrentDate] = useState(new Date());
  const [scheduleType, setScheduleType] = useState<ScheduleType>(
    consultant.scheduleType,
  );
  const [formData, setFormData] = useState<FormData>(
    getInitialFormData(consultant),
  );
  const [serviceSettings, setServiceSettings] = useState<ServiceSettings>(
    getInitialServiceSettings(consultant),
  );
  const [domains, setDomains] = useState<Domain[]>([]);
  const [subDomains, setSubDomains] = useState<SubDomain[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);

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
  const handleScheduleTypeChange = useCallback((value: ScheduleType) => {
    setScheduleType(value);
    setFormData((prev) => ({
      ...prev,
      scheduleType: value,
    }));

    // Clear slots for the inactive schedule type
    if (value === ScheduleType.WEEKLY) {
      setCustomSlots({});
    } else {
      setWeeklySlots({});
    }
  }, []);

  const handleAddSlot = useCallback(
    (day: string) => {
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
      const updateSlots = (prev: SlotsType) => {
        const updatedSlots = {
          ...prev,
          [day]: prev[day].map((slot, i) =>
            i === index ? { ...slot, [field]: value } : slot,
          ),
        };
        // Pass the correct context for slot splitting
        updatedSlots[day][index] = validateSlot(
          updatedSlots[day][index],
          updatedSlots[day].filter((_, i) => i !== index),
          day,
          scheduleType === ScheduleType.WEEKLY
            ? setWeeklySlots
            : setCustomSlots,
          scheduleType === ScheduleType.WEEKLY,
        );
        return updatedSlots;
      };

      if (scheduleType === ScheduleType.WEEKLY) {
        setWeeklySlots(updateSlots);
      } else {
        setCustomSlots(updateSlots);
      }
    },
    [scheduleType],
  );

  const handleDeleteSlot = useCallback(
    (day: string, index: number) => {
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
            const newCustomSlots = { ...customSlots };
            if (isSelected) {
              delete newCustomSlots[dateString];
            } else {
              newCustomSlots[dateString] = [
                { startTime: "", endTime: "", isValid: false },
              ];
            }
            setCustomSlots(newCustomSlots);
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
    if (!validateAllSlots(currentSlots)) {
      toast({
        title: "Validation Error",
        description: "Please ensure all time slots are valid before saving.",
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
        language: serviceSettings.language,
        level: serviceSettings.level,
        prerequisites: serviceSettings.prerequisites,
        scheduleType, // Ensure we're using the current scheduleType
        slotsOfAvailabilityWeekly:
          scheduleType === ScheduleType.WEEKLY
            ? formatSlotsForApi(weeklySlots, true)
            : [],
        slotsOfAvailabilityCustom:
          scheduleType === ScheduleType.CUSTOM
            ? formatSlotsForApi(customSlots, false)
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

  if (isContentLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-t-black border-r-black border-b-gray-200 border-l-gray-200 rounded-full animate-spin mb-4"></div>
          <p className="text-gray-500">Loading settings...</p>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white p-6 rounded-lg shadow space-y-8"
      onClick={(e) => {
        if (
          (e.target as HTMLElement).tagName !== "BUTTON" ||
          (e.target as HTMLButtonElement).type !== "submit"
        ) {
          e.preventDefault();
        }
      }}
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
                      {(domains || []).map((domain) => (
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
                    value={formData.experience}
                    onChange={handleInputChange}
                    placeholder="e.g. 5+ years in machine learning"
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

        <RadioGroup
          value={scheduleType}
          onValueChange={handleScheduleTypeChange}
          className="flex flex-col md:flex-row md:space-x-8 space-y-4 md:space-y-0"
        >
          {/* Weekly Schedule */}
          <div className="flex-1">
            <div className="flex items-center justify-between mb-4">
              <Label htmlFor="WEEKLY" className="font-medium">
                Weekly Recurring
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
                  {weeklySlots[day.toLowerCase()]?.map((slot, index) => (
                    <div key={index} className="space-y-2">
                      <div className="grid grid-cols-7 gap-2 items-center">
                        <Input
                          type="time"
                          value={slot.startTime}
                          onChange={(e) =>
                            handleUpdateSlot(
                              day.toLowerCase(),
                              index,
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
                              index,
                              "endTime",
                              e.target.value,
                            )
                          }
                          className={`col-span-2 ${!slot.isValid ? "border-red-500" : ""}`}
                          step="900"
                        />
                        <TrashIcon
                          className="w-5 h-5 cursor-pointer"
                          onClick={() =>
                            handleDeleteSlot(day.toLowerCase(), index)
                          }
                        />
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
              <Label htmlFor="CUSTOM" className="font-medium">
                Custom Schedule
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
                .sort()
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
                      {customSlots[dateString]?.map((slot, index) => (
                        <div key={index} className="space-y-2">
                          <div className="grid grid-cols-7 gap-2 items-center">
                            <Input
                              type="time"
                              value={slot.startTime}
                              onChange={(e) =>
                                handleUpdateSlot(
                                  dateString,
                                  index,
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
                                  index,
                                  "endTime",
                                  e.target.value,
                                )
                              }
                              className={`col-span-2 ${!slot.isValid ? "border-red-500" : ""}`}
                              step="900"
                            />
                            <TrashIcon
                              className="w-5 h-5 cursor-pointer"
                              onClick={() =>
                                handleDeleteSlot(dateString, index)
                              }
                            />
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

      <Separator />

      {/* Service Settings */}
      <div>
        <h2 className="text-xl font-semibold mb-2">Service Configuration</h2>
        <p className="text-sm text-gray-500 mb-6">
          Manage your service offerings and preferences
        </p>

        <div className="space-y-6">
          <Card className="p-6">
            <h3 className="font-medium mb-4">Default Service Settings</h3>
            <div className="space-y-4">
              <div>
                <Label>Default Language</Label>
                <Input
                  name="language"
                  value={serviceSettings.language}
                  onChange={(e) =>
                    setServiceSettings((prev) => ({
                      ...prev,
                      language: e.target.value,
                    }))
                  }
                  placeholder="e.g., English"
                />
              </div>
              <div>
                <Label>Default Level</Label>
                <Select
                  value={serviceSettings.level}
                  onValueChange={(value) =>
                    setServiceSettings((prev) => ({ ...prev, level: value }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select default level" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="beginner">Beginner</SelectItem>
                    <SelectItem value="intermediate">Intermediate</SelectItem>
                    <SelectItem value="advanced">Advanced</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Prerequisites Template</Label>
                <Textarea
                  name="prerequisites"
                  value={serviceSettings.prerequisites}
                  onChange={(e) =>
                    setServiceSettings((prev) => ({
                      ...prev,
                      prerequisites: e.target.value,
                    }))
                  }
                  placeholder="Default prerequisites for your services"
                />
              </div>
            </div>
          </Card>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex justify-end space-x-4 pt-6">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setFormData(getInitialFormData(consultant));
            setServiceSettings(getInitialServiceSettings(consultant));
            if (scheduleType === ScheduleType.WEEKLY) {
              setWeeklySlots(getInitialWeeklySlots(consultant));
            } else {
              setCustomSlots({});
            }
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
