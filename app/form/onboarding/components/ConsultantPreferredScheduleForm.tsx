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
import {
  PreferredSchedule,
  PreferredScheduleSchema,
} from "@/schemas/UserSchema";
import { zodResolver } from "@hookform/resolvers/zod";
import React, { useCallback, useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";

type DayOfWeek = "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY";

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

const DAYS_OF_WEEK: DayOfWeek[] = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];

const getLocalDateString = (date: Date): string => {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const formatDayDisplay = (day: DayOfWeek): string => {
  return day.charAt(0) + day.slice(1).toLowerCase();
};

// Extract time from datetime string (e.g., "2024-01-01T09:30:00" -> "09:30")
const extractTimeFromDateTime = (dateTimeString: string): string => {
  try {
    if (dateTimeString.includes('T')) {
      const [_, time] = dateTimeString.split('T');
      return time.substring(0, 5); // Get HH:mm part only
    }
    // If it's already in HH:mm format, return as is
    if (/^\d{2}:\d{2}$/.test(dateTimeString)) {
      return dateTimeString;
    }
    // If it's in HH:mm:ss format, truncate seconds
    if (/^\d{2}:\d{2}:\d{2}$/.test(dateTimeString)) {
      return dateTimeString.substring(0, 5);
    }
    return '';
  } catch (error) {
    console.error('Error extracting time:', error);
    return '';
  }
};

const ConsultantPreferredScheduleForm: React.FC<Props> = ({ onNext, onBack, initialData }) => {
  const { handleSubmit, watch, setValue, control } = useForm<PreferredSchedule>({
    resolver: zodResolver(PreferredScheduleSchema),
    defaultValues: {
      ...initialData,
      scheduleType: initialData.scheduleType || "WEEKLY"
    },
  });
  const scheduleType = watch("scheduleType");
  
  const [weeklySlots, setWeeklySlots] = useState<SlotsType>({});
  const [customSlots, setCustomSlots] = useState<SlotsType>({});

  // Initialize slots from initialData
  useEffect(() => {
    if (initialData.weeklySlots?.length) {
      const formattedWeeklySlots: SlotsType = {};
      initialData.weeklySlots.forEach(slot => {
        const day = slot.dayOfWeekforStartTimeInUTC.toLowerCase();
        if (!formattedWeeklySlots[day]) {
          formattedWeeklySlots[day] = [];
        }
        formattedWeeklySlots[day].push({
          startTime: extractTimeFromDateTime(slot.slotStartTimeInUTC),
          endTime: extractTimeFromDateTime(slot.slotEndTimeInUTC),
          isValid: true
        });
      });
      setWeeklySlots(formattedWeeklySlots);
    }

    if (initialData.customSlots?.length) {
      const formattedCustomSlots: SlotsType = {};
      initialData.customSlots.forEach(slot => {
        try {
          const startDate = new Date(slot.slotStartTimeInUTC);
          const dateString = getLocalDateString(startDate);
          if (!formattedCustomSlots[dateString]) {
            formattedCustomSlots[dateString] = [];
          }
          formattedCustomSlots[dateString].push({
            startTime: extractTimeFromDateTime(slot.slotStartTimeInUTC),
            endTime: extractTimeFromDateTime(slot.slotEndTimeInUTC),
            isValid: true
          });
        } catch (error) {
          console.error('Error processing custom slot:', error);
        }
      });
      setCustomSlots(formattedCustomSlots);
    }
  }, [initialData]);

  useEffect(() => {
    const formattedWeeklySlots = Object.entries(weeklySlots).flatMap(([day, slots]) =>
      slots.map(slot => ({
        dayOfWeekforStartTimeInUTC: day.toUpperCase() as DayOfWeek,
        dayOfWeekforEndTimeInUTC: day.toUpperCase() as DayOfWeek,
        slotStartTimeInUTC: slot.startTime,
        slotEndTimeInUTC: slot.endTime
      }))
    );
    setValue("weeklySlots", formattedWeeklySlots);
  }, [weeklySlots, setValue]);

  useEffect(() => {
    const formattedCustomSlots = Object.entries(customSlots).flatMap(([dateString, slots]) =>
      slots.map(slot => {
        const startDateTime = `${dateString}T${slot.startTime}`;
        const endDateTime = `${dateString}T${slot.endTime}`;
        return {
          slotStartTimeInUTC: startDateTime,
          slotEndTimeInUTC: endDateTime
        };
      })
    );
    setValue("customSlots", formattedCustomSlots);
  }, [customSlots, setValue]);

  const validateSlot = useCallback((slot: SlotType, otherSlots: SlotType[]): SlotType => {
    const getMinutes = (time: string): number | null => {
      const [hours, minutes] = time.split(":").map(Number);
      return !isNaN(hours) && !isNaN(minutes) ? hours * 60 + minutes : null;
    };

    const startMinutes = getMinutes(slot.startTime);
    const endMinutes = getMinutes(slot.endTime);

    if (startMinutes === null || endMinutes === null) {
      return { ...slot, isValid: false, errorMessage: "Invalid time format" };
    }

    if (endMinutes <= startMinutes) {
      return { ...slot, isValid: false, errorMessage: "End time must be after start time" };
    }

    if (startMinutes % 15 !== 0 || endMinutes % 15 !== 0) {
      return { ...slot, isValid: false, errorMessage: "Times must be in multiples of 15 minutes" };
    }

    if (endMinutes - startMinutes < 30) {
      return { ...slot, isValid: false, errorMessage: "Session must be at least 30 minutes long" };
    }

    if ((endMinutes - startMinutes) % 30 !== 0) {
      return { ...slot, isValid: false, errorMessage: "Session duration must be in multiples of 30 minutes" };
    }

    for (const otherSlot of otherSlots) {
      const otherStartMinutes = getMinutes(otherSlot.startTime);
      const otherEndMinutes = getMinutes(otherSlot.endTime);
      if (otherStartMinutes === null || otherEndMinutes === null) continue;

      if (
        (startMinutes >= otherStartMinutes && startMinutes < otherEndMinutes + 15) ||
        (endMinutes > otherStartMinutes - 15 && endMinutes <= otherEndMinutes) ||
        (startMinutes <= otherStartMinutes && endMinutes >= otherEndMinutes)
      ) {
        return { ...slot, isValid: false, errorMessage: "Must have at least a 15-minute break between sessions" };
      }
    }

    return { ...slot, isValid: true, errorMessage: undefined };
  }, []);

  const handleAddSlot = useCallback((day: string, slots: SlotsType, setSlots: React.Dispatch<React.SetStateAction<SlotsType>>) => {
    setSlots((prev) => ({
      ...prev,
      [day]: [...(prev[day] || []), { startTime: "", endTime: "", isValid: false }],
    }));
  }, []);

  const handleUpdateSlot = useCallback((
    day: string,
    index: number,
    field: "startTime" | "endTime",
    value: string,
    slots: SlotsType,
    setSlots: React.Dispatch<React.SetStateAction<SlotsType>>
  ) => {
    setSlots((prev) => {
      const updatedSlots = {
        ...prev,
        [day]: prev[day].map((slot, i) => (i === index ? { ...slot, [field]: value } : slot)),
      };
      updatedSlots[day][index] = validateSlot(
        updatedSlots[day][index],
        updatedSlots[day].filter((_, i) => i !== index)
      );
      return updatedSlots;
    });
  }, [validateSlot]);

  const handleDeleteSlot = useCallback((day: string, index: number, slots: SlotsType, setSlots: React.Dispatch<React.SetStateAction<SlotsType>>) => {
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
  }, []);

  const renderSlots = useCallback((day: DayOfWeek, slots: SlotsType, setSlots: React.Dispatch<React.SetStateAction<SlotsType>>) => {
    const dayKey = day.toLowerCase();
    return (
      <div key={`slot-${day}`} className="grid gap-2">
        <Label>{formatDayDisplay(day)}</Label>
        {slots[dayKey]?.map((slot: SlotType, index: number) => (
          <div key={`slot-${day}-${index}`} className="grid gap-2">
            <div className="grid grid-cols-5 gap-2 items-center">
              <Input
                type="time"
                value={slot.startTime}
                onChange={(e) => handleUpdateSlot(dayKey, index, "startTime", e.target.value, slots, setSlots)}
                className={`col-span-2 ${!slot.isValid ? "border-red-500" : ""}`}
                required
                step="900"
              />
              <Input
                type="time"
                value={slot.endTime}
                onChange={(e) => handleUpdateSlot(dayKey, index, "endTime", e.target.value, slots, setSlots)}
                className={`col-span-2 ${!slot.isValid ? "border-red-500" : ""}`}
                required
                step="900"
              />
              <TrashIcon
                className="w-5 h-5 cursor-pointer"
                onClick={() => handleDeleteSlot(dayKey, index, slots, setSlots)}
              />
            </div>
            {!slot.isValid && slot.errorMessage && (
              <p className="text-red-500 text-sm">{slot.errorMessage}</p>
            )}
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          onClick={() => handleAddSlot(dayKey, slots, setSlots)}
        >
          Add Slot
        </Button>
      </div>
    );
  }, [handleAddSlot, handleUpdateSlot, handleDeleteSlot]);

  const allSlotsValid = useCallback(() => {
    const areAllSlotsValid = (slots: SlotsType) =>
      Object.values(slots).every((daySlots) => daySlots.every((slot) => slot.isValid));
    
    if (scheduleType === "WEEKLY") {
      return areAllSlotsValid(weeklySlots) && Object.keys(weeklySlots).length > 0;
    } else {
      return areAllSlotsValid(customSlots) && Object.keys(customSlots).length > 0;
    }
  }, [weeklySlots, customSlots, scheduleType]);

  const onSubmitForm = useCallback((data: PreferredSchedule) => {
    if (!allSlotsValid()) {
      alert("Please add and validate at least one time slot before proceeding.");
      return;
    }
    onNext(data);
  }, [allSlotsValid, onNext]);

  const [currentDate, setCurrentDate] = useState(new Date());

  const getDaysInMonth = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  };

  const getFirstDayOfMonth = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth(), 1).getDay();
  };

  const handlePrevMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
  };

  const handleNextMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
  };

  const renderCalendar = () => {
    const daysInMonth = getDaysInMonth(currentDate);
    const firstDayOfMonth = getFirstDayOfMonth(currentDate);
    const days = [];

    for (let i = 0; i < firstDayOfMonth; i++) {
      days.push(<div key={`empty-${i}`} className="p-2"></div>);
    }

    for (let i = 1; i <= daysInMonth; i++) {
      const date = new Date(currentDate.getFullYear(), currentDate.getMonth(), i);
      const dateString = getLocalDateString(date);
      const isSelected = customSlots[dateString] !== undefined;
      days.push(
        <button
          key={`day-${i}`}
          type="button"
          className={`p-2 rounded-full hover:bg-gray-200
            ${isSelected ? 'bg-black text-white' : ''}`}
          onClick={() => {
            const newCustomSlots = { ...customSlots };
            if (isSelected) {
              delete newCustomSlots[dateString];
            } else {
              newCustomSlots[dateString] = [{ startTime: "", endTime: "", isValid: false }];
            }
            setCustomSlots(newCustomSlots);
          }}
        >
          {i}
        </button>
      );
    }

    return days;
  };

  const renderSlotsForDate = (dateString: string) => {
    const date = new Date(dateString);
    return (
      <div key={`date-${dateString}`} className="mt-4">
        <h4 className="font-semibold">{date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</h4>
        {customSlots[dateString]?.map((slot: SlotType, index: number) => (
          <div key={`custom-slot-${dateString}-${index}`} className="grid grid-cols-5 gap-2 items-center mt-2">
            <Input
              type="time"
              value={slot.startTime}
              onChange={(e) => handleUpdateSlot(dateString, index, "startTime", e.target.value, customSlots, setCustomSlots)}
              className={`col-span-2 ${!slot.isValid ? "border-red-500" : ""}`}
              required
              step="900"
            />
            <Input
              type="time"
              value={slot.endTime}
              onChange={(e) => handleUpdateSlot(dateString, index, "endTime", e.target.value, customSlots, setCustomSlots)}
              className={`col-span-2 ${!slot.isValid ? "border-red-500" : ""}`}
              required
              step="900"
            />
            <TrashIcon
              className="w-5 h-5 cursor-pointer"
              onClick={() => handleDeleteSlot(dateString, index, customSlots, setCustomSlots)}
            />
          </div>
        ))}
        {customSlots[dateString]?.map((slot: SlotType, index: number) => (
          !slot.isValid && slot.errorMessage && (
            <p key={`custom-error-${dateString}-${index}`} className="text-red-500 text-sm mt-1">{slot.errorMessage}</p>
          )
        ))}
        <Button
          type="button"
          variant="outline"
          onClick={() => handleAddSlot(dateString, customSlots, setCustomSlots)}
          className="mt-2"
        >
          Add Slot
        </Button>
      </div>
    );
  };

  return (
    <form onSubmit={handleSubmit(onSubmitForm)} className="w-full max-w-6xl mx-auto">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Preferred Schedule</CardTitle>
          <CardDescription>Choose how you'd like to schedule your appointments.</CardDescription>
        </CardHeader>
        <CardContent>
          <Controller
            name="scheduleType"
            control={control}
            defaultValue="WEEKLY"
            render={({ field }) => (
              <RadioGroup onValueChange={field.onChange} value={field.value} className="space-y-4">
                <div className="flex flex-col md:flex-row md:space-x-8 space-y-4 md:space-y-0">
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-4">
                      <Label htmlFor="WEEKLY" className="font-medium">Weekly Recurring</Label>
                      <RadioGroupItem id="WEEKLY" value="WEEKLY" />
                    </div>
                    <div className={`grid gap-4 ${scheduleType !== "WEEKLY" ? "opacity-50 pointer-events-none" : ""}`}>
                      {DAYS_OF_WEEK.map((day) => renderSlots(day, weeklySlots, setWeeklySlots))}
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-4">
                      <Label htmlFor="CUSTOM" className="font-medium">Custom Schedule</Label>
                      <RadioGroupItem id="CUSTOM" value="CUSTOM" />
                    </div>
                    <div className={`grid gap-4 ${scheduleType !== "CUSTOM" ? "opacity-50 pointer-events-none" : ""}`}>
                      <div className="calendar-container bg-white border p-4 rounded-lg">
                        <div className="flex justify-between items-center mb-4">
                          <button type="button" className="text-black" onClick={handlePrevMonth}>&larr;</button>
                          <span>{currentDate.toLocaleString('default', { month: 'long', year: 'numeric' })}</span>
                          <button type="button" className="text-black" onClick={handleNextMonth}>&rarr;</button>
                        </div>
                        <div className="grid grid-cols-7 gap-1 text-center">
                          {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(day => (
                            <div key={`header-${day}`} className="text-sm font-medium">{day}</div>
                          ))}
                          {renderCalendar()}
                        </div>
                      </div>
                      {Object.keys(customSlots).sort().map(dateString => renderSlotsForDate(dateString))}
                    </div>
                  </div>
                </div>
              </RadioGroup>
            )}
          />
        </CardContent>
        <CardFooter className="flex justify-between">
          <Button type="button" onClick={onBack} variant="outline">Back</Button>
          <Button type="submit" variant="night" disabled={!allSlotsValid()}>Next</Button>
        </CardFooter>
      </Card>
    </form>
  );
};

export default ConsultantPreferredScheduleForm;
