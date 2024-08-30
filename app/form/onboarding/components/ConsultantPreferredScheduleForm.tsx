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
  preferredScheduleSchema,
} from "@/schemas/UserSchema";
import { zodResolver } from "@hookform/resolvers/zod";
import React, { useCallback, useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";

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

const DAYS_OF_WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// New function to get local date string
const getLocalDateString = (date: Date): string => {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const ConsultantPreferredScheduleForm: React.FC<Props> = ({ onNext, onBack, initialData }) => {
  const { handleSubmit, watch, setValue, control } = useForm<PreferredSchedule>({
    resolver: zodResolver(preferredScheduleSchema),
    defaultValues: initialData,
  });
  const scheduleType = watch("scheduleType");
  const [weeklySlots, setWeeklySlots] = useState<SlotsType>((initialData.weeklySlots as SlotsType) || {});
  const [customSlots, setCustomSlots] = useState<SlotsType>((initialData.customSlots as SlotsType) || {});

  useEffect(() => {
    setValue("weeklySlots", weeklySlots);
  }, [weeklySlots, setValue]);

  useEffect(() => {
    setValue("customSlots", customSlots);
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

  const renderSlots = useCallback((day: string, slots: SlotsType, setSlots: React.Dispatch<React.SetStateAction<SlotsType>>) => (
    <div key={day} className="grid gap-2">
      <Label>{day}</Label>
      {slots[day]?.map((slot: SlotType, index: number) => (
        <div key={index} className="grid gap-2">
          <div className="grid grid-cols-5 gap-2 items-center">
            <Input
              type="time"
              value={slot.startTime}
              onChange={(e) => handleUpdateSlot(day, index, "startTime", e.target.value, slots, setSlots)}
              className={`col-span-2 ${!slot.isValid ? "border-red-500" : ""}`}
              required
              step="900"
            />
            <Input
              type="time"
              value={slot.endTime}
              onChange={(e) => handleUpdateSlot(day, index, "endTime", e.target.value, slots, setSlots)}
              className={`col-span-2 ${!slot.isValid ? "border-red-500" : ""}`}
              required
              step="900"
            />
            <TrashIcon
              className="w-5 h-5 cursor-pointer"
              onClick={() => handleDeleteSlot(day, index, slots, setSlots)}
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
        onClick={() => handleAddSlot(day, slots, setSlots)}
      >
        Add Slot
      </Button>
    </div>
  ), [handleAddSlot, handleUpdateSlot, handleDeleteSlot]);

  const allSlotsValid = useCallback(() => {
    const areAllSlotsValid = (slots: SlotsType) =>
      Object.values(slots).every((daySlots) => daySlots.every((slot) => slot.isValid));
    return areAllSlotsValid(weeklySlots) && areAllSlotsValid(customSlots);
  }, [weeklySlots, customSlots]);

  const onSubmitForm = useCallback((data: PreferredSchedule) => {
    if (!allSlotsValid()) {
      alert("Please correct all slot times before submitting.");
      return;
    }
    onNext(data);
  }, [allSlotsValid, onNext]);


  // Generate Calendar
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
          key={i}
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
      <div key={dateString} className="mt-4">
        <h4 className="font-semibold">{date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</h4>
        {customSlots[dateString]?.map((slot: SlotType, index: number) => (
          <div key={index} className="grid grid-cols-5 gap-2 items-center mt-2">
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
            <p key={`error-${index}`} className="text-red-500 text-sm mt-1">{slot.errorMessage}</p>
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
    <form onSubmit={handleSubmit(onSubmitForm)} className="w-full max-w-md">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Preferred Schedule</CardTitle>
          <CardDescription>Choose how you'd like to schedule your appointments.</CardDescription>
        </CardHeader>
        <CardContent>
          <Controller
            name="scheduleType"
            control={control}
            defaultValue="weekly"
            render={({ field }) => (
              <RadioGroup onValueChange={field.onChange} value={field.value}>
                <div className="flex items-center justify-between">
                  <Label htmlFor="weekly" className="font-medium">Weekly Recurring</Label>
                  <RadioGroupItem id="weekly" value="weekly" />
                </div>
                <div className={`grid gap-4 mt-4 ${scheduleType !== "weekly" ? "opacity-50 pointer-events-none" : ""}`}>
                  {DAYS_OF_WEEK.map((day) => renderSlots(day, weeklySlots, setWeeklySlots))}
                </div>
                <div className="flex items-center justify-between mt-6">
                  <Label htmlFor="custom" className="font-medium">Custom Schedule</Label>
                  <RadioGroupItem id="custom" value="custom" />
                </div>
                <div className={`grid gap-4 mt-4 ${scheduleType !== "custom" ? "opacity-50 pointer-events-none" : ""}`}>
                  <div className="calendar-container bg-white border p-4 rounded-lg">
                    <div className="flex justify-between items-center mb-4">
                      <button type="button" className="text-black" onClick={handlePrevMonth}>&lt;</button>
                      <span>{currentDate.toLocaleString('default', { month: 'long', year: 'numeric' })}</span>
                      <button type="button" className="text-black" onClick={handleNextMonth}>&gt;</button>
                    </div>
                    <div className="grid grid-cols-7 gap-1 text-center">
                      {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(day => (
                        <div key={day} className="text-sm font-medium">{day}</div>
                      ))}
                      {renderCalendar()}
                    </div>
                  </div>
                  {Object.keys(customSlots).sort().map(dateString => renderSlotsForDate(dateString))}
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

function CalendarDaysIcon(props: Readonly<React.SVGProps<SVGSVGElement>>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" />
      <path d="M8 14h.01" />
      <path d="M12 14h.01" />
      <path d="M16 14h.01" />
      <path d="M8 18h.01" />
      <path d="M12 18h.01" />
      <path d="M16 18h.01" />
    </svg>
  );
}

function TrashIcon(props: Readonly<React.SVGProps<SVGSVGElement>>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}

export default ConsultantPreferredScheduleForm;