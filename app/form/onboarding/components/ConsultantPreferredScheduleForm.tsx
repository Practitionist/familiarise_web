import { useTimezone } from "@/app/explore/experts/[consultantId]/hooks/useTimezone";
import { TrashIcon } from "@/assets/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { PreferredSchedule } from "@/schemas/user";
import {
  DAYS_OF_WEEK,
  type DayOfWeek,
  convertUtcToTimezone,
  extractTimeFromUtcSlot,
  formatDayDisplay,
  getDaysInMonth,
  getFirstDayOfMonth,
  getLocalDateString,
  sortSlotsByTime,
} from "@/utils/dateTimeUtils";
import {
  OnboardingFormData,
  PreferredScheduleFormSchema,
} from "@/utils/onboarding";
import { validateTimeSlot } from "@/utils/timeSlotValidation";
import { minuteUtcToDate } from "@/utils/slotAllocation/slotTimeUtils";
import {
  SlotValidationFeedback,
  useSlotValidationFeedback,
} from "@/components/schedule/SlotValidationFeedback";
import type { SlotType, SlotsType } from "@/utils/schedule/types";
import {
  buildCustomSlotsForSave,
  buildWeeklySlotsForSave,
} from "@/utils/schedule/formatting";
import { useToast } from "@/hooks/use-toast";
import { zodResolver } from "@hookform/resolvers/zod";
import React, { useCallback, useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";

interface Props {
  onNext: (data: Partial<OnboardingFormData>) => void;
  onBack: () => void;
  initialData: Partial<OnboardingFormData>;
}


const ConsultantPreferredScheduleForm: React.FC<Props> = ({
  onNext,
  onBack,
  initialData,
}) => {
  const { timezone, isLoading: timezoneLoading } = useTimezone();
  const { toast } = useToast();
  const { handleSubmit, watch, setValue, control, reset } = useForm({
    resolver: zodResolver(PreferredScheduleFormSchema),
    defaultValues: {
      ...initialData,
      scheduleType: initialData.scheduleType || "WEEKLY",
    },
  });
  const scheduleType = watch("scheduleType");

  const [weeklySlots, setWeeklySlots] = useState<SlotsType>({});
  const [customSlots, setCustomSlots] = useState<SlotsType>({});

  // Sync form values when initialData changes (for back navigation)
  useEffect(() => {
    if (initialData && Object.keys(initialData).length > 0) {
      reset({
        ...initialData,
        scheduleType: initialData.scheduleType || "WEEKLY",
      });
    }
  }, [initialData, reset]);

  // Initialize slots from initialData with timezone awareness
  useEffect(() => {
    if (!timezone || timezoneLoading) return;

    if (initialData.weeklySlots?.length) {
      const formattedWeeklySlots: SlotsType = {};
      const refDate = new Date("1970-01-05T00:00:00Z");
      initialData.weeklySlots.forEach((slot) => {
        const day = slot.startDay.toLowerCase();
        if (!formattedWeeklySlots[day]) {
          formattedWeeklySlots[day] = [];
        }
        formattedWeeklySlots[day].push({
          startTime: extractTimeFromUtcSlot(
            minuteUtcToDate(slot.startTimeUtc, refDate).toISOString(),
            timezone,
          ),
          endTime: extractTimeFromUtcSlot(
            minuteUtcToDate(slot.endTimeUtc, refDate).toISOString(),
            timezone,
          ),
          isValid: true,
        });
      });

      Object.keys(formattedWeeklySlots).forEach((day) => {
        formattedWeeklySlots[day] = sortSlotsByTime(formattedWeeklySlots[day]);
      });

      setWeeklySlots(formattedWeeklySlots);
    }

    if (initialData.customSlots?.length) {
      const formattedCustomSlots: SlotsType = {};
      initialData.customSlots.forEach((slot) => {
        try {
          const startDate = new Date(slot.startsAt);
          const dateString = startDate.toLocaleDateString("en-CA", {
            timeZone: timezone,
          });
          if (!formattedCustomSlots[dateString]) {
            formattedCustomSlots[dateString] = [];
          }
          formattedCustomSlots[dateString].push({
            startTime: convertUtcToTimezone(
              slot.startsAt.toString(),
              timezone,
            ),
            endTime: convertUtcToTimezone(
              slot.endsAt.toString(),
              timezone,
            ),
            isValid: true,
          });
        } catch (error) {
          console.error("Error processing custom slot:", error);
        }
      });

      Object.keys(formattedCustomSlots).forEach((dateString) => {
        formattedCustomSlots[dateString] = sortSlotsByTime(
          formattedCustomSlots[dateString],
        );
      });

      setCustomSlots(formattedCustomSlots);
    }
  }, [initialData, timezone, timezoneLoading]);

  // Format weekly slots for API
  useEffect(() => {
    if (!timezone) return;
    setValue("weeklySlots", buildWeeklySlotsForSave(weeklySlots, timezone));
  }, [weeklySlots, setValue, timezone]);

  // Format custom slots for API
  useEffect(() => {
    if (!timezone) return;
    setValue("customSlots", buildCustomSlotsForSave(customSlots, timezone));
  }, [customSlots, setValue, timezone]);

  const handleAddSlot = useCallback(
    (
      day: string,
      _slots: SlotsType,
      setSlots: React.Dispatch<React.SetStateAction<SlotsType>>,
    ) => {
      setSlots((prev) => {
        const newSlots = {
          ...prev,
          [day]: [
            ...(prev[day] || []),
            { startTime: "", endTime: "", isValid: false },
          ],
        };
        if (newSlots[day]) {
          newSlots[day] = sortSlotsByTime(newSlots[day]);
        }
        return newSlots;
      });
    },
    [],
  );

  const handleUpdateSlot = useCallback(
    (
      day: string,
      index: number,
      field: "startTime" | "endTime",
      value: string,
      _slots: SlotsType,
      setSlots: React.Dispatch<React.SetStateAction<SlotsType>>,
    ) => {
      setSlots((prev) => {
        const updatedSlots = {
          ...prev,
          [day]: prev[day].map((slot, i) =>
            i === index ? { ...slot, [field]: value } : slot,
          ),
        };
        const validationResult = validateTimeSlot(
          updatedSlots[day][index],
          updatedSlots[day].filter((_, i) => i !== index),
        );
        updatedSlots[day][index] = validationResult;

        if (updatedSlots[day]) {
          updatedSlots[day] = sortSlotsByTime(updatedSlots[day]);
        }

        return updatedSlots;
      });
    },
    [scheduleType],
  );

  const handleDeleteSlot = useCallback(
    (
      day: string,
      index: number,
      _slots: SlotsType,
      setSlots: React.Dispatch<React.SetStateAction<SlotsType>>,
    ) => {
      setSlots((prev) => {
        const updatedSlots = {
          ...prev,
          [day]: prev[day].filter((_, i) => i !== index),
        };
        if (updatedSlots[day].length === 0) {
          delete updatedSlots[day];
        } else {
          updatedSlots[day] = sortSlotsByTime(updatedSlots[day]);
        }
        return updatedSlots;
      });
    },
    [],
  );

  const renderSlots = useCallback(
    (
      day: DayOfWeek,
      slots: SlotsType,
      setSlots: React.Dispatch<React.SetStateAction<SlotsType>>,
    ) => {
      const dayKey = day.toLowerCase();
      return (
        <div
          key={`slot-${day}`}
          className="grid gap-3 p-4 rounded-lg bg-muted/50 border"
        >
          <Label className="font-medium text-sm">{formatDayDisplay(day)}</Label>
          {slots[dayKey]?.map((slot: SlotType, index: number) => (
            <div key={`slot-${day}-${index}`} className="grid gap-3">
              <div className="grid grid-cols-5 gap-3 items-center">
                <Input
                  type="time"
                  value={slot.startTime}
                  onChange={(e) =>
                    handleUpdateSlot(
                      dayKey,
                      index,
                      "startTime",
                      e.target.value,
                      slots,
                      setSlots,
                    )
                  }
                  className={`col-span-2 h-10 ${
                    !slot.isValid ? "border-destructive" : ""
                  }`}
                  required
                  step="900"
                />
                <Input
                  type="time"
                  value={slot.endTime}
                  onChange={(e) =>
                    handleUpdateSlot(
                      dayKey,
                      index,
                      "endTime",
                      e.target.value,
                      slots,
                      setSlots,
                    )
                  }
                  className={`col-span-2 h-10 ${
                    !slot.isValid ? "border-destructive" : ""
                  }`}
                  required
                  step="900"
                />
                <TrashIcon
                  className="w-5 h-5 cursor-pointer text-destructive hover:text-destructive/80 transition-colors"
                  onClick={() =>
                    handleDeleteSlot(dayKey, index, slots, setSlots)
                  }
                />
              </div>
              {!slot.isValid && slot.errorMessage && (
                <p className="text-destructive text-sm">{slot.errorMessage}</p>
              )}
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            onClick={() => handleAddSlot(dayKey, slots, setSlots)}
            className="h-10 font-medium"
          >
            + Add Slot
          </Button>
        </div>
      );
    },
    [handleAddSlot, handleUpdateSlot, handleDeleteSlot],
  );

  // Use shared validation feedback hook
  const currentSlots = scheduleType === "WEEKLY" ? weeklySlots : customSlots;
  const validationFeedback = useSlotValidationFeedback(currentSlots);
  const allSlotsValid =
    validationFeedback.isValid && validationFeedback.hasSlots;

  const onSubmitForm = useCallback(
    (data: PreferredSchedule) => {
      if (!validationFeedback.hasSlots) {
        toast({
          title: "No Time Slots",
          description: "Please add at least one time slot before proceeding.",
          variant: "destructive",
        });
        return;
      }

      if (!validationFeedback.isValid) {
        console.error("[Schedule Validation] Submission blocked:", {
          errorCount: validationFeedback.errors.length,
          errors: validationFeedback.errors,
        });
        toast({
          title: "Schedule Has Errors",
          description: "Please fix the highlighted issues before proceeding.",
          variant: "destructive",
        });
        return;
      }

      onNext(data);
    },
    [validationFeedback, onNext, toast],
  );

  const [currentDate, setCurrentDate] = useState(new Date());

  const handlePrevMonth = () => {
    setCurrentDate(
      new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1),
    );
  };

  const handleNextMonth = () => {
    setCurrentDate(
      new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1),
    );
  };

  const renderCalendar = () => {
    const daysInMonth = getDaysInMonth(currentDate);
    const firstDayOfMonth = getFirstDayOfMonth(currentDate);
    const days = [];

    for (let i = 0; i < firstDayOfMonth; i++) {
      days.push(<div key={`empty-${i}`} className="p-2"></div>);
    }

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
          className={`p-2 rounded-lg transition-all duration-200 text-sm font-medium ${
            isSelected
              ? "bg-primary text-primary-foreground shadow-lg"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
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
  };

  const renderSlotsForDate = (dateString: string) => {
    const date = new Date(dateString);
    return (
      <div
        key={`date-${dateString}`}
        className="mt-4 p-4 rounded-lg bg-muted/50 border"
      >
        <h4 className="font-semibold mb-3">
          {date.toLocaleDateString("en-US", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          })}
        </h4>
        {customSlots[dateString]?.map((slot: SlotType, index: number) => (
          <div
            key={`custom-slot-${dateString}-${index}`}
            className="grid grid-cols-5 gap-3 items-center mt-3"
          >
            <Input
              type="time"
              value={slot.startTime}
              onChange={(e) =>
                handleUpdateSlot(
                  dateString,
                  index,
                  "startTime",
                  e.target.value,
                  customSlots,
                  setCustomSlots,
                )
              }
              className={`col-span-2 h-10 ${
                !slot.isValid ? "border-destructive" : ""
              }`}
              required
              step="900"
            />
            <Input
              type="time"
              value={slot.endTime}
              onChange={(e) =>
                handleUpdateSlot(
                  dateString,
                  index,
                  "endTime",
                  e.target.value,
                  customSlots,
                  setCustomSlots,
                )
              }
              className={`col-span-2 h-10 ${
                !slot.isValid ? "border-destructive" : ""
              }`}
              required
              step="900"
            />
            <TrashIcon
              className="w-5 h-5 cursor-pointer text-destructive hover:text-destructive/80 transition-colors"
              onClick={() =>
                handleDeleteSlot(dateString, index, customSlots, setCustomSlots)
              }
            />
          </div>
        ))}
        {customSlots[dateString]?.map(
          (slot: SlotType, index: number) =>
            !slot.isValid &&
            slot.errorMessage && (
              <p
                key={`custom-error-${dateString}-${index}`}
                className="text-destructive text-sm mt-1"
              >
                {slot.errorMessage}
              </p>
            ),
        )}
        <Button
          type="button"
          variant="outline"
          onClick={() => handleAddSlot(dateString, customSlots, setCustomSlots)}
          className="mt-3 h-10 font-medium"
        >
          + Add Slot
        </Button>
      </div>
    );
  };

  // Show loading state while timezone is being detected
  if (timezoneLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-t-primary border-r-primary border-b-muted border-l-muted rounded-full animate-spin mb-4"></div>
          <p className="text-muted-foreground">Detecting timezone...</p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmitForm)} className="space-y-6">
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Availability Schedule
        </h3>
        <p className="text-sm text-muted-foreground">
          Choose how you'd like to schedule your appointments.
        </p>
      </div>

      <Controller
        name="scheduleType"
        control={control}
        defaultValue="WEEKLY"
        render={({ field }) => (
          <RadioGroup
            onValueChange={field.onChange}
            value={field.value}
            className="space-y-6"
          >
            {/* Schedule Type Selector */}
            <div className="flex justify-center">
              <div className="inline-flex rounded-lg border p-1 bg-muted/50">
                <button
                  type="button"
                  onClick={() => field.onChange("WEEKLY")}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
                    field.value === "WEEKLY"
                      ? "bg-background shadow-sm"
                      : "hover:bg-muted"
                  }`}
                >
                  Weekly
                </button>
                <button
                  type="button"
                  onClick={() => field.onChange("CUSTOM")}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
                    field.value === "CUSTOM"
                      ? "bg-background shadow-sm"
                      : "hover:bg-muted"
                  }`}
                >
                  Custom
                </button>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              {/* Weekly Schedule */}
              <div className="space-y-4">
                <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border">
                  <Label htmlFor="WEEKLY" className="font-medium">
                    Weekly Recurring
                  </Label>
                  <RadioGroupItem id="WEEKLY" value="WEEKLY" />
                </div>
                <div
                  className={`grid gap-4 ${
                    scheduleType !== "WEEKLY"
                      ? "opacity-30 pointer-events-none"
                      : ""
                  }`}
                >
                  {DAYS_OF_WEEK.map((day) =>
                    renderSlots(day, weeklySlots, setWeeklySlots),
                  )}
                </div>
              </div>

              {/* Custom Schedule */}
              <div className="space-y-4">
                <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border">
                  <Label htmlFor="CUSTOM" className="font-medium">
                    Custom Schedule
                  </Label>
                  <RadioGroupItem id="CUSTOM" value="CUSTOM" />
                </div>
                <div
                  className={`grid gap-4 ${
                    scheduleType !== "CUSTOM"
                      ? "opacity-30 pointer-events-none"
                      : ""
                  }`}
                >
                  <div className="calendar-container bg-muted/50 border p-4 rounded-lg">
                    <div className="flex justify-between items-center mb-4">
                      <button
                        type="button"
                        className="hover:text-primary transition-colors p-2 rounded-lg hover:bg-muted"
                        onClick={handlePrevMonth}
                      >
                        &larr;
                      </button>
                      <span className="font-semibold">
                        {currentDate.toLocaleString("default", {
                          month: "long",
                          year: "numeric",
                        })}
                      </span>
                      <button
                        type="button"
                        className="hover:text-primary transition-colors p-2 rounded-lg hover:bg-muted"
                        onClick={handleNextMonth}
                      >
                        &rarr;
                      </button>
                    </div>
                    <div className="grid grid-cols-7 gap-1 text-center">
                      {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
                        <div
                          key={`header-${day}`}
                          className="text-sm font-medium text-muted-foreground p-2"
                        >
                          {day}
                        </div>
                      ))}
                      {renderCalendar()}
                    </div>
                  </div>
                  {Object.keys(customSlots)
                    .sort((a, b) => a.localeCompare(b))
                    .map((dateString) => renderSlotsForDate(dateString))}
                </div>
              </div>
            </div>
          </RadioGroup>
        )}
      />

      {/* Validation Feedback - using shared component */}
      <SlotValidationFeedback slots={currentSlots} />

      {/* Navigation */}
      <div className="flex gap-4 pt-4">
        <Button
          type="button"
          onClick={onBack}
          variant="outline"
          className="flex-1"
        >
          Back
        </Button>
        <Button type="submit" disabled={!allSlotsValid} className="flex-1">
          Continue
        </Button>
      </div>
    </form>
  );
};

export default ConsultantPreferredScheduleForm;
