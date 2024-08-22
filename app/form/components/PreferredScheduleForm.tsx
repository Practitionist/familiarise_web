import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { zodResolver } from "@hookform/resolvers/zod";
import React, { useCallback, useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import {
  PreferredSchedule,
  preferredScheduleSchema,
} from "../../../schemas/userSchema";

interface SlotType {
  startTime: string;
  endTime: string;
  isValid: boolean;
  errorMessage?: string;
}

type SlotsType = Record<string, SlotType[]>;

interface Props {
  onSubmit: (data: PreferredSchedule) => void;
  onBack: () => void;
  initialData: Partial<PreferredSchedule>;
}

const DAYS_OF_WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const PreferredScheduleForm: React.FC<Props> = ({ onSubmit, onBack, initialData }) => {
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
    onSubmit(data);
  }, [allSlotsValid, onSubmit]);

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
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline">
                        Pick dates
                        <CalendarDaysIcon className="ml-auto h-4 w-4 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="multiple"
                        selected={Object.keys(customSlots).map((dateString) => new Date(dateString))}
                        onSelect={(days) => {
                          if (days) {
                            const newCustomSlots = { ...customSlots };
                            days.forEach((day) => {
                              const dateString = day.toISOString().split("T")[0];
                              if (!newCustomSlots[dateString]) {
                                newCustomSlots[dateString] = [{ startTime: "", endTime: "", isValid: false }];
                              }
                            });
                            Object.keys(newCustomSlots).forEach((dateString) => {
                              if (!days.some((day) => day.toISOString().split("T")[0] === dateString)) {
                                delete newCustomSlots[dateString];
                              }
                            });
                            setCustomSlots(newCustomSlots);
                          }
                        }}
                        className="rounded-md border"
                      />
                    </PopoverContent>
                  </Popover>
                  {Object.entries(customSlots).map(([dateString, slots]) => renderSlots(new Date(dateString).toDateString(), { [dateString]: slots }, setCustomSlots))}
                </div>
              </RadioGroup>
            )}
          />
        </CardContent>
        <CardFooter className="flex justify-between">
          <Button type="button" onClick={onBack} variant="outline">Back</Button>
          <Button type="submit" variant="night" disabled={!allSlotsValid()}>Submit</Button>
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

export default PreferredScheduleForm;