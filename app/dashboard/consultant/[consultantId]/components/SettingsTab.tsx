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
import {
  DAYS_OF_WEEK,
  formatDayDisplay,
  getInitialFormData,
  getInitialWeeklySlots,
  getInitialServiceSettings,
  validateSlot,
  validateAllSlots,
  updateConsultantSettings,
  getDaysInMonth,
  getFirstDayOfMonth,
  getMonthYearString,
  getLocalDateString,
  type FormData,
  type SlotType,
  type SlotsType,
  type ServiceSettings,
} from "../settings";

interface SettingsTabProps {
  consultant: TConsultantProfile;
}

export function SettingsTab({ consultant }: SettingsTabProps) {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [weeklySlots, setWeeklySlots] = useState<SlotsType>(getInitialWeeklySlots(consultant));
  const [customSlots, setCustomSlots] = useState<SlotsType>({});
  const [currentDate, setCurrentDate] = useState(new Date());
  const [scheduleType, setScheduleType] = useState<ScheduleType>(consultant.scheduleType);
  const [formData, setFormData] = useState<FormData>(getInitialFormData(consultant));
  const [serviceSettings, setServiceSettings] = useState<ServiceSettings>(getInitialServiceSettings(consultant));

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleAddSlot = useCallback((day: string) => {
    if (scheduleType === ScheduleType.WEEKLY) {
      setWeeklySlots((prev) => ({
        ...prev,
        [day]: [
          ...(prev[day] || []),
          { startTime: "", endTime: "", isValid: false },
        ],
      }));
    } else {
      setCustomSlots((prev) => ({
        ...prev,
        [day]: [
          ...(prev[day] || []),
          { startTime: "", endTime: "", isValid: false },
        ],
      }));
    }
  }, [scheduleType]);

  const handleUpdateSlot = useCallback((
    day: string,
    index: number,
    field: "startTime" | "endTime",
    value: string
  ) => {
    const updateSlots = (prev: SlotsType) => {
      const updatedSlots = {
        ...prev,
        [day]: prev[day].map((slot, i) =>
          i === index ? { ...slot, [field]: value } : slot
        ),
      };
      updatedSlots[day][index] = validateSlot(
        updatedSlots[day][index],
        updatedSlots[day].filter((_, i) => i !== index)
      );
      return updatedSlots;
    };

    if (scheduleType === ScheduleType.WEEKLY) {
      setWeeklySlots(updateSlots);
    } else {
      setCustomSlots(updateSlots);
    }
  }, [scheduleType]);

  const handleDeleteSlot = useCallback((day: string, index: number) => {
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
  }, [scheduleType]);

  const handlePrevMonth = useCallback(() => {
    setCurrentDate(prev => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
  }, []);

  const handleNextMonth = useCallback(() => {
    setCurrentDate(prev => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
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
      const date = new Date(currentDate.getFullYear(), currentDate.getMonth(), i);
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
        </button>
      );
    }

    return days;
  }, [currentDate, customSlots]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!consultant?.id || !validateAllSlots(weeklySlots, scheduleType)) {
      toast({
        title: "Validation Error",
        description: "Please ensure all time slots are valid before saving.",
        variant: "destructive",
      });
      return;
    }
    
    setIsLoading(true);
    try {
      await updateConsultantSettings(
        consultant.id,
        formData,
        scheduleType,
        scheduleType === ScheduleType.WEEKLY ? weeklySlots : customSlots
      );

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

  return (
    <div className="bg-white p-6 rounded-lg shadow space-y-8">
      {/* Professional Profile */}
      <div>
        <h2 className="text-xl font-semibold mb-2">Professional Profile</h2>
        <p className="text-sm text-gray-500 mb-6">
          Update your professional information and expertise
        </p>
        
        <div className="grid grid-cols-2 gap-6">
          <div className="space-y-4">
            <div>
              <Label>Qualifications</Label>
              <Textarea
                name="qualifications"
                value={formData.qualifications}
                onChange={handleInputChange}
                placeholder="Your professional qualifications"
              />
            </div>
            <div>
              <Label>Specialization</Label>
              <Input
                name="specialization"
                value={formData.specialization}
                onChange={handleInputChange}
                placeholder="Your area of expertise"
              />
            </div>
            <div>
              <Label>Experience</Label>
              <Input
                name="experience"
                value={formData.experience}
                onChange={handleInputChange}
                placeholder="Years of professional experience"
              />
            </div>
          </div>
          
          <div className="space-y-4">
            <div>
              <Label>Professional Description</Label>
              <Textarea
                name="description"
                value={formData.description}
                onChange={handleInputChange}
                placeholder="Describe your professional background and expertise"
                className="h-[calc(100%-2rem)]"
              />
            </div>
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
          onValueChange={(value: ScheduleType) => setScheduleType(value)}
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
            <div className={`space-y-4 ${scheduleType !== ScheduleType.WEEKLY ? "opacity-50 pointer-events-none" : ""}`}>
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
                              e.target.value
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
                              e.target.value
                            )
                          }
                          className={`col-span-2 ${!slot.isValid ? "border-red-500" : ""}`}
                          step="900"
                        />
                        <TrashIcon
                          className="w-5 h-5 cursor-pointer"
                          onClick={() => handleDeleteSlot(day.toLowerCase(), index)}
                        />
                      </div>
                      {!slot.isValid && slot.errorMessage && (
                        <p className="text-red-500 text-sm">{slot.errorMessage}</p>
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
            <div className={`space-y-4 ${scheduleType !== ScheduleType.CUSTOM ? "opacity-50 pointer-events-none" : ""}`}>
              <div className="calendar-container bg-white border p-4 rounded-lg">
                <div className="flex justify-between items-center mb-4">
                  <button
                    type="button"
                    className="text-black hover:bg-gray-100 p-2 rounded-full"
                    onClick={handlePrevMonth}
                  >
                    &larr;
                  </button>
                  <span className="font-medium">{getMonthYearString(currentDate)}</span>
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
                                  e.target.value
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
                                  e.target.value
                                )
                              }
                              className={`col-span-2 ${!slot.isValid ? "border-red-500" : ""}`}
                              step="900"
                            />
                            <TrashIcon
                              className="w-5 h-5 cursor-pointer"
                              onClick={() => handleDeleteSlot(dateString, index)}
                            />
                          </div>
                          {!slot.isValid && slot.errorMessage && (
                            <p className="text-red-500 text-sm">{slot.errorMessage}</p>
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
        <Button 
          onClick={handleSubmit}
          disabled={isLoading}
        >
          {isLoading ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}
