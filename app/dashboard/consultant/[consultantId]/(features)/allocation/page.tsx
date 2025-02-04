"use client";

import { DayOfWeek } from "@prisma/client";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CalendarIcon,
  MenuIcon,
  OptionIcon,
  SearchIcon,
  TargetIcon,
  TimerIcon,
  UserIcon,
} from "assets/icons";
import { Button } from "components/ui/button";
import { format } from "date-fns";
import { use, useCallback, useState } from "react";
import { AddScheduleDialog } from "./components/AddScheduleDialog";
import { AllocationMonthView } from "./components/AllocationMonthView";
import { AllocationWeekView } from "./components/AllocationWeekView";
import { useCalendarNavigation } from "./hooks/useCalendarNavigation";
import { useSlots } from "./hooks/useSlots";
import { NewSlot } from "./utils";
import { useToast } from "@/hooks/use-toast";

export default function AllocationPage({
  params,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
}>) {
  const resolvedParams = use(params);
  const { toast } = useToast();
  const consultantId = resolvedParams.consultantId;

  const [isAddScheduleOpen, setIsAddScheduleOpen] = useState(false);
  const [newSlot, setNewSlot] = useState<NewSlot>({
    type: "weekly",
    dayOfWeekforStartTimeInUTC: "MONDAY",
    dayOfWeekforEndTimeInUTC: "MONDAY",
    slotStartTimeInUTC: new Date(),
    slotEndTimeInUTC: new Date(),
  });

  const { slots, addSlot } = useSlots();
  const { currentDate, view, setView, navigate } = useCalendarNavigation();

  const handleAddSlot = useCallback(async () => {
    try {
      await addSlot(newSlot);
      setIsAddScheduleOpen(false);
      toast({
        title: "Slot added",
        description: `New slot added: ${format(newSlot.slotStartTimeInUTC, "PPpp")} - ${format(newSlot.slotEndTimeInUTC, "PPpp")}`,
      });
    } catch (error) {
      console.error("Error adding slot:", error);
      toast({
        title: "Error",
        description: "Failed to add slot. Please try again.",
        variant: "destructive",
      });
    }
  }, [addSlot, newSlot]);

  const handleCellClick = useCallback(
    (day: Date, hour: number) => {
      const startTime = new Date(day);
      startTime.setHours(hour, 0, 0, 0);
      const endTime = new Date(startTime);
      endTime.setHours(hour + 1, 0, 0, 0);

      setNewSlot({
        type: view === "week" ? "weekly" : "custom",
        dayOfWeekforStartTimeInUTC: [
          "SUNDAY",
          "MONDAY",
          "TUESDAY",
          "WEDNESDAY",
          "THURSDAY",
          "FRIDAY",
          "SATURDAY",
        ][day.getDay()] as DayOfWeek,
        dayOfWeekforEndTimeInUTC: [
          "SUNDAY",
          "MONDAY",
          "TUESDAY",
          "WEDNESDAY",
          "THURSDAY",
          "FRIDAY",
          "SATURDAY",
        ][day.getDay()] as DayOfWeek,
        slotStartTimeInUTC: startTime,
        slotEndTimeInUTC: endTime,
      });
      setIsAddScheduleOpen(true);
    },
    [view],
  );

  const calendarContent =
    view === "week" ? (
      <AllocationWeekView
        currentDate={currentDate}
        slots={slots}
        onCellClick={handleCellClick}
      />
    ) : (
      <AllocationMonthView
        currentDate={currentDate}
        slots={slots}
        onCellClick={handleCellClick}
      />
    );

  return (
    <div className="flex flex-col min-h-screen bg-gray-50">
      <header className="flex items-center justify-between p-4 bg-white border-b shadow-sm">
        <div className="flex items-center space-x-4">
          <MenuIcon className="w-6 h-6 text-gray-600" />
          <h1 className="text-lg font-semibold text-gray-800">Calendar</h1>
        </div>
        <div className="flex items-center space-x-4">
          <SearchIcon className="w-6 h-6 text-gray-600" />
          <UserIcon className="w-6 h-6 text-gray-600" />
        </div>
      </header>
      <div className="flex flex-1">
        <aside className="w-64 p-4 bg-white border-r">
          <div className="mb-6">
            <h2 className="text-xl font-semibold text-gray-800">
              {format(currentDate, "MMMM yyyy")}
            </h2>
          </div>
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-gray-700 mb-2">
              Scheduled
            </h2>
            <ul className="space-y-2">
              <li className="flex items-center space-x-2 text-gray-600 hover:text-gray-800">
                <CalendarIcon className="w-4 h-4" />
                <span>Calendars</span>
              </li>
              <li className="flex items-center space-x-2 text-gray-600 hover:text-gray-800">
                <CalendarIcon className="w-4 h-4" />
                <span>Holiday</span>
              </li>
              <li className="flex items-center space-x-2 text-gray-600 hover:text-gray-800">
                <TimerIcon className="w-4 h-4" />
                <span>Reminders</span>
              </li>
              <li className="flex items-center space-x-2 text-gray-600 hover:text-gray-800">
                <TimerIcon className="w-4 h-4" />
                <span>Tasks</span>
              </li>
              <li className="flex items-center space-x-2 text-gray-600 hover:text-gray-800">
                <OptionIcon className="w-4 h-4" />
                <span>Other Calendars</span>
              </li>
              <li className="flex items-center space-x-2 text-gray-600 hover:text-gray-800">
                <TargetIcon className="w-4 h-4" />
                <span>Target</span>
              </li>
            </ul>
          </div>
        </aside>
        <main className="flex-1 p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center space-x-4">
              <Button
                variant={view === "week" ? "default" : "outline"}
                onClick={() => setView("week")}
                className="text-sm font-medium"
              >
                Week
              </Button>
              <Button
                variant={view === "month" ? "default" : "outline"}
                onClick={() => setView("month")}
                className="text-sm font-medium"
              >
                Month
              </Button>
            </div>
            <div className="flex items-center space-x-4">
              <TimerIcon className="w-6 h-6 text-gray-600" />
              <span className="text-lg font-medium text-gray-800">
                {format(currentDate, "MMMM yyyy")}
              </span>
              <Button
                variant="outline"
                size="icon"
                onClick={() => navigate("prev")}
              >
                <ArrowLeftIcon className="w-4 h-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={() => navigate("next")}
              >
                <ArrowRightIcon className="w-4 h-4" />
              </Button>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow-md overflow-hidden">
            {calendarContent}
          </div>
          <AddScheduleDialog
            isOpen={isAddScheduleOpen}
            onOpenChange={setIsAddScheduleOpen}
            newSlot={newSlot}
            setNewSlot={setNewSlot}
            onAddSlot={handleAddSlot}
          />
        </main>
      </div>
    </div>
  );
}
