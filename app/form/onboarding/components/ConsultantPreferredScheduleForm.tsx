import { TrashIcon } from "@/assets/icons";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { PreferredSchedule, PreferredScheduleSchema } from "@/schemas/user";
import { validateTimeSlot } from "@/utils/timeSlotValidation";
import { zodResolver } from "@hookform/resolvers/zod";
import React, { useCallback, useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import {
  DAYS_OF_WEEK,
  type DayOfWeek,
  convertToLocalTime,
  convertToUTC,
  formatDayDisplay,
  getDaysInMonth,
  getFirstDayOfMonth,
  getLocalDateString,
  getNextDay,
  isOvernight,
} from "../timeUtils";

interface SlotType {
  startTime: string;
  endTime: string;
  isValid: boolean;
  errorMessage?: string;
}

type SlotsType = Record<string, SlotType[]>;

interface Props {
  onNext: (data: Partial<PreferredSchedule>) => void;
  onBack: () => void;
  initialData: Partial<PreferredSchedule>;
}

interface WeeklySlot {
  dayOfWeekforStartTimeInUTC: DayOfWeek;
  dayOfWeekforEndTimeInUTC: DayOfWeek;
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
}

interface CustomSlot {
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
}

const isValidSlot = (slot: SlotType): slot is SlotType & { isValid: true } => {
  return Boolean(slot.startTime && slot.endTime && slot.isValid);
};

const ConsultantPreferredScheduleForm: React.FC<Props> = ({
  onNext,
  onBack,
  initialData,
}) => {
  const { handleSubmit, watch, setValue, control } = useForm<PreferredSchedule>(
    {
      resolver: zodResolver(PreferredScheduleSchema),
      defaultValues: {
        ...initialData,
        scheduleType: initialData.scheduleType || "WEEKLY",
      },
    },
  );
  const scheduleType = watch("scheduleType");

  const [weeklySlots, setWeeklySlots] = useState<SlotsType>({});
  const [customSlots, setCustomSlots] = useState<SlotsType>({});

  // Initialize slots from initialData
  useEffect(() => {
    if (initialData.weeklySlots?.length) {
      const formattedWeeklySlots: SlotsType = {};
      initialData.weeklySlots.forEach((slot) => {
        const day = slot.dayOfWeekforStartTimeInUTC.toLowerCase();
        if (!formattedWeeklySlots[day]) {
          formattedWeeklySlots[day] = [];
        }
        formattedWeeklySlots[day].push({
          startTime: convertToLocalTime(slot.slotStartTimeInUTC),
          endTime: convertToLocalTime(slot.slotEndTimeInUTC),
          isValid: true,
        });
      });
      setWeeklySlots(formattedWeeklySlots);
    }

    if (initialData.customSlots?.length) {
      const formattedCustomSlots: SlotsType = {};
      initialData.customSlots.forEach((slot) => {
        try {
          const startDate = new Date(slot.slotStartTimeInUTC);
          const dateString = getLocalDateString(startDate);
          if (!formattedCustomSlots[dateString]) {
            formattedCustomSlots[dateString] = [];
          }
          formattedCustomSlots[dateString].push({
            startTime: convertToLocalTime(slot.slotStartTimeInUTC),
            endTime: convertToLocalTime(slot.slotEndTimeInUTC),
            isValid: true,
          });
        } catch (error) {
          console.error("Error processing custom slot:", error);
        }
      });
      setCustomSlots(formattedCustomSlots);
    }
  }, [initialData]);

  useEffect(() => {
    const formattedWeeklySlots = Object.entries(weeklySlots).flatMap(
      ([day, slots]) => {
        return slots.filter(isValidSlot).flatMap((slot): WeeklySlot[] => {
          const baseDate = "2024-01-01";
          const nextDate = "2024-01-02";
          const overnight = isOvernight(slot.startTime, slot.endTime);

          const startUTC = convertToUTC(slot.startTime, baseDate);
          const endUTC = convertToUTC(
            slot.endTime,
            overnight ? nextDate : baseDate,
          );

          if (!startUTC || !endUTC) return [];

          if (overnight) {
            const midnightUTC = convertToUTC("00:00", nextDate);
            if (!midnightUTC) return [];

            const startDay = day.toUpperCase() as DayOfWeek;
            const endDay = getNextDay(startDay);

            return [
              {
                dayOfWeekforStartTimeInUTC: startDay,
                dayOfWeekforEndTimeInUTC: startDay,
                slotStartTimeInUTC: startUTC,
                slotEndTimeInUTC: midnightUTC,
              },
              {
                dayOfWeekforStartTimeInUTC: endDay,
                dayOfWeekforEndTimeInUTC: endDay,
                slotStartTimeInUTC: midnightUTC,
                slotEndTimeInUTC: endUTC,
              },
            ];
          }

          return [
            {
              dayOfWeekforStartTimeInUTC: day.toUpperCase() as DayOfWeek,
              dayOfWeekforEndTimeInUTC: day.toUpperCase() as DayOfWeek,
              slotStartTimeInUTC: startUTC,
              slotEndTimeInUTC: endUTC,
            },
          ];
        });
      },
    );
    setValue("weeklySlots", formattedWeeklySlots);
  }, [weeklySlots, setValue]);

  useEffect(() => {
    const formattedCustomSlots = Object.entries(customSlots).flatMap(
      ([dateString, slots]) => {
        return slots.filter(isValidSlot).flatMap((slot): CustomSlot[] => {
          const nextDate = new Date(dateString);
          nextDate.setDate(nextDate.getDate() + 1);
          const nextDateStr = getLocalDateString(nextDate);
          const overnight = isOvernight(slot.startTime, slot.endTime);

          const startUTC = convertToUTC(slot.startTime, dateString);
          const endUTC = convertToUTC(
            slot.endTime,
            overnight ? nextDateStr : dateString,
          );

          if (!startUTC || !endUTC) return [];

          if (overnight) {
            const midnightUTC = convertToUTC("00:00", nextDateStr);
            if (!midnightUTC) return [];

            return [
              {
                slotStartTimeInUTC: startUTC,
                slotEndTimeInUTC: midnightUTC,
              },
              {
                slotStartTimeInUTC: midnightUTC,
                slotEndTimeInUTC: endUTC,
              },
            ];
          }

          return [
            {
              slotStartTimeInUTC: startUTC,
              slotEndTimeInUTC: endUTC,
            },
          ];
        });
      },
    );
    setValue("customSlots", formattedCustomSlots);
  }, [customSlots, setValue]);

  const handleAddSlot = useCallback(
    (
      day: string,
      slots: SlotsType,
      setSlots: React.Dispatch<React.SetStateAction<SlotsType>>,
    ) => {
      setSlots((prev) => ({
        ...prev,
        [day]: [
          ...(prev[day] || []),
          { startTime: "", endTime: "", isValid: false },
        ],
      }));
    },
    [],
  );

  const handleUpdateSlot = useCallback(
    (
      day: string,
      index: number,
      field: "startTime" | "endTime",
      value: string,
      slots: SlotsType,
      setSlots: React.Dispatch<React.SetStateAction<SlotsType>>,
    ) => {
      setSlots((prev) => {
        const updatedSlots = {
          ...prev,
          [day]: prev[day].map((slot, i) =>
            i === index ? { ...slot, [field]: value } : slot,
          ),
        };
        updatedSlots[day][index] = validateTimeSlot(
          updatedSlots[day][index],
          updatedSlots[day].filter((_, i) => i !== index),
          day,
          setSlots,
          scheduleType === "WEEKLY",
        );
        return updatedSlots;
      });
    },
    [scheduleType],
  );

  const handleDeleteSlot = useCallback(
    (
      day: string,
      index: number,
      slots: SlotsType,
      setSlots: React.Dispatch<React.SetStateAction<SlotsType>>,
    ) => {
      setSlots((prev) => {
        const updatedSlots = {
          ...prev,
          [day]: prev[day].filter((_, i) => i !== index),
        };
        if (updatedSlots[day].length === 0) {
          delete updatedSlots[day];
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
        <div key={`slot-${day}`} className="grid gap-3 p-4 rounded-lg bg-white/5 border border-white/10">
          <Label className="text-white font-medium text-sm">{formatDayDisplay(day)}</Label>
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
                  className={`col-span-2 bg-white/10 border-white/20 text-white h-10 rounded-lg focus:border-purple-400 focus:ring-purple-400/20 ${
                    !slot.isValid ? "border-red-400" : ""
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
                  className={`col-span-2 bg-white/10 border-white/20 text-white h-10 rounded-lg focus:border-purple-400 focus:ring-purple-400/20 ${
                    !slot.isValid ? "border-red-400" : ""
                  }`}
                  required
                  step="900"
                />
                <TrashIcon
                  className="w-5 h-5 cursor-pointer text-red-400 hover:text-red-300 transition-colors"
                  onClick={() =>
                    handleDeleteSlot(dayKey, index, slots, setSlots)
                  }
                />
              </div>
              {!slot.isValid && slot.errorMessage && (
                <p className="text-red-400 text-sm">{slot.errorMessage}</p>
              )}
            </div>
          ))}
          <Button
            type="button"
            onClick={() => handleAddSlot(dayKey, slots, setSlots)}
            className="bg-white/10 border-white/20 text-white hover:bg-white/20 hover:border-white/30 rounded-lg h-10 font-medium transition-all duration-200"
          >
            + Add Slot
          </Button>
        </div>
      );
    },
    [handleAddSlot, handleUpdateSlot, handleDeleteSlot],
  );

  const allSlotsValid = useCallback(() => {
    const areAllSlotsValid = (slots: SlotsType) =>
      Object.values(slots).every((daySlots) =>
        daySlots.every((slot) => slot.isValid),
      );

    if (scheduleType === "WEEKLY") {
      return (
        areAllSlotsValid(weeklySlots) && Object.keys(weeklySlots).length > 0
      );
    } else {
      return (
        areAllSlotsValid(customSlots) && Object.keys(customSlots).length > 0
      );
    }
  }, [weeklySlots, customSlots, scheduleType]);

  const onSubmitForm = useCallback(
    (data: PreferredSchedule) => {
      if (!allSlotsValid()) {
        alert(
          "Please add and validate at least one time slot before proceeding.",
        );
        return;
      }
      onNext(data);
    },
    [allSlotsValid, onNext],
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
              ? "bg-gradient-to-r from-purple-500 to-blue-500 text-white shadow-lg" 
              : "text-white/70 hover:bg-white/10 hover:text-white"
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
      <div key={`date-${dateString}`} className="mt-4 p-4 rounded-lg bg-white/5 border border-white/10">
        <h4 className="font-semibold text-white mb-3">
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
              className={`col-span-2 bg-white/10 border-white/20 text-white h-10 rounded-lg focus:border-purple-400 focus:ring-purple-400/20 ${
                !slot.isValid ? "border-red-400" : ""
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
              className={`col-span-2 bg-white/10 border-white/20 text-white h-10 rounded-lg focus:border-purple-400 focus:ring-purple-400/20 ${
                !slot.isValid ? "border-red-400" : ""
              }`}
              required
              step="900"
            />
            <TrashIcon
              className="w-5 h-5 cursor-pointer text-red-400 hover:text-red-300 transition-colors"
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
                className="text-red-400 text-sm mt-1"
              >
                {slot.errorMessage}
              </p>
            ),
        )}
        <Button
          type="button"
          onClick={() => handleAddSlot(dateString, customSlots, setCustomSlots)}
          className="mt-3 bg-white/10 border-white/20 text-white hover:bg-white/20 hover:border-white/30 rounded-lg h-10 font-medium transition-all duration-200"
        >
          + Add Slot
        </Button>
      </div>
    );
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmitForm)}
      className="w-full space-y-6"
    >
      <div className="glassmorphism2 rounded-2xl p-6 border border-white/20 shadow-2xl">
        <div className="mb-6">
          <h3 className="text-2xl font-bold text-white mb-2">Preferred Schedule</h3>
          <p className="text-white/70">
            Choose how you'd like to schedule your appointments.
          </p>
        </div>
        <div>
          <Controller
            name="scheduleType"
            control={control}
            defaultValue="WEEKLY"
            render={({ field }) => (
              <RadioGroup
                onValueChange={field.onChange}
                value={field.value}
                className="space-y-4"
              >
                <div className="flex flex-col lg:flex-row lg:space-x-8 space-y-6 lg:space-y-0">
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-4 p-4 rounded-lg bg-white/5 border border-white/10">
                      <Label htmlFor="WEEKLY" className="font-medium text-white text-lg">
                        📅 Weekly Recurring
                      </Label>
                      <RadioGroupItem id="WEEKLY" value="WEEKLY" className="border-white/30 text-purple-400" />
                    </div>
                    <div
                      className={`grid gap-4 ${scheduleType !== "WEEKLY" ? "opacity-30 pointer-events-none" : ""}`}
                    >
                      {DAYS_OF_WEEK.map((day) =>
                        renderSlots(day, weeklySlots, setWeeklySlots),
                      )}
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-4 p-4 rounded-lg bg-white/5 border border-white/10">
                      <Label htmlFor="CUSTOM" className="font-medium text-white text-lg">
                        🗓️ Custom Schedule
                      </Label>
                      <RadioGroupItem id="CUSTOM" value="CUSTOM" className="border-white/30 text-purple-400" />
                    </div>
                    <div
                      className={`grid gap-4 ${scheduleType !== "CUSTOM" ? "opacity-30 pointer-events-none" : ""}`}
                    >
                      <div className="calendar-container bg-white/10 border-white/20 border p-4 rounded-lg backdrop-blur-sm">
                        <div className="flex justify-between items-center mb-4">
                          <button
                            type="button"
                            className="text-white hover:text-purple-400 transition-colors p-2 rounded-lg hover:bg-white/10"
                            onClick={handlePrevMonth}
                          >
                            ←
                          </button>
                          <span className="text-white font-semibold">
                            {currentDate.toLocaleString("default", {
                              month: "long",
                              year: "numeric",
                            })}
                          </span>
                          <button
                            type="button"
                            className="text-white hover:text-purple-400 transition-colors p-2 rounded-lg hover:bg-white/10"
                            onClick={handleNextMonth}
                          >
                            →
                          </button>
                        </div>
                        <div className="grid grid-cols-7 gap-1 text-center">
                          {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map(
                            (day) => (
                              <div
                                key={`header-${day}`}
                                className="text-sm font-medium text-white/70 p-2"
                              >
                                {day}
                              </div>
                            ),
                          )}
                          {renderCalendar()}
                        </div>
                      </div>
                      {Object.keys(customSlots)
                        .sort()
                        .map((dateString) => renderSlotsForDate(dateString))}
                    </div>
                  </div>
                </div>
              </RadioGroup>
            )}
          />
        </div>
        <div className="flex justify-between gap-4 pt-6 mt-6 border-t border-white/20">
          <Button 
            type="button" 
            onClick={onBack} 
            className="flex-1 h-12 bg-white/10 border-white/20 text-white hover:bg-white/20 hover:border-white/30 rounded-lg font-medium transition-all duration-200"
          >
            ← Back
          </Button>
          <Button 
            type="submit" 
            disabled={!allSlotsValid()}
            className="flex-1 h-12 bg-gradient-to-r from-purple-500 to-blue-500 text-white font-semibold rounded-lg shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40 transition-all duration-200 border-0 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Next Step →
          </Button>
        </div>
      </div>
    </form>
  );
};

export default ConsultantPreferredScheduleForm;
