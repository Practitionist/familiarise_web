import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronLeft, ChevronRight } from "lucide-react";
import React, { useState } from "react";

type CalendarProps = {
  availableSlots: string[] | undefined;
  existingAppointments: string[] | undefined;
  onSlotSelect: (slot: string) => void;
  selectedSlots: string[] | undefined;
  requiredSlots: number;
  scheduleType: "WEEKLY" | "CUSTOM";
  consultantTimezone: string;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOURS = Array.from({ length: 48 }, (_, i) => i / 2);

export function Calendar({
  availableSlots = [],
  existingAppointments = [],
  onSlotSelect,
  selectedSlots = [],
  requiredSlots,
  scheduleType,
  consultantTimezone,
}: CalendarProps) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [view, setView] = useState<"week" | "month">("week");

  console.log("From Calendar availableSlots", availableSlots);

  const navigatePrevious = () => {
    setCurrentDate(
      new Date(
        currentDate.setDate(currentDate.getDate() - (view === "week" ? 7 : 30)),
      ),
    );
  };

  const navigateNext = () => {
    setCurrentDate(
      new Date(
        currentDate.setDate(currentDate.getDate() + (view === "week" ? 7 : 30)),
      ),
    );
  };

  const getDaysInMonth = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  };

  const renderTimeCell = (date: Date, hour: number) => {
    const { hr, min } = {
      hr: Math.floor(hour),
      min: hour % 1 === 0 ? 0 : 30,
    };
    const slotDate = new Date(date);
    const slotDateWithZeroDate = new Date(0);
    slotDate.setUTCHours(hr, min, 0, 0);
    slotDateWithZeroDate.setUTCHours(hr, min, 0, 0);
    slotDateWithZeroDate.setDate(date.getDay());
    const slotString = slotDate.toISOString();
    const slotStringWithZeroDate = slotDateWithZeroDate.toISOString();
    const isAvailable = availableSlots?.includes(slotStringWithZeroDate);
    const isExisting = existingAppointments?.includes(slotString);
    const isSelected = selectedSlots?.includes(slotString);
    const now = new Date();
    const isInPast = slotDate < now;

    return (
      <Button
        key={`${date.toISOString()}-${hour}`}
        variant={isSelected ? "default" : isAvailable ? "outline" : "ghost"}
        className={`h-8 md:h-12 w-full relative border
          ${isExisting ? "bg-gray-200 hover:bg-gray-200" : ""}
          ${isInPast ? "opacity-50" : ""}
        `}
        onClick={() => isAvailable && !isInPast && onSlotSelect(slotString)}
        disabled={!isAvailable || isExisting || isInPast}
      >
        <div className="flex flex-col items-center gap-0.5 md:gap-1 text-[10px] md:text-xs">
          {scheduleType === "WEEKLY" && isAvailable && <span>🔄</span>}
          {isExisting
            ? "Booked"
            : isSelected
              ? "Selected"
              : isAvailable
                ? "Available"
                : ""}
        </div>
      </Button>
    );
  };

  const renderWeekView = () => {
    const startOfWeek = new Date(currentDate);
    startOfWeek.setDate(currentDate.getDate() - currentDate.getDay());

    return (
      <div className="flex flex-col h-[calc(100vh-20rem)] md:h-[65vh] max-h-[600px]">
        <div className="grid grid-cols-8 gap-0.5 md:gap-1">
          <div className="w-12 md:w-20"></div>
          {DAYS.map((day, index) => {
            const date = new Date(startOfWeek);
            date.setDate(startOfWeek.getDate() + index);
            const isToday = date.toDateString() === new Date().toDateString();
            return (
              <div key={day} className="text-center p-1 md:p-2">
                <div
                  className={`font-bold text-xs md:text-base ${isToday ? "text-primary" : ""}`}
                >
                  {day.slice(0, 3)}
                </div>
                <div className="text-xs md:text-sm text-muted-foreground">
                  {date.getDate()}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          <div className="grid grid-cols-8 gap-0.5 md:gap-1">
            {HOURS.map((hour) => (
              <React.Fragment key={hour}>
                <div className="w-12 md:w-20 text-right pr-2 text-[10px] md:text-sm sticky left-0 bg-background z-10">

                  {Math.floor(hour).toString().padStart(2, "0")}:{hour % 1 === 0 ? "00" : "30"}
                </div>
                {DAYS.map((_, dayIndex) => {
                  const date = new Date(startOfWeek);
                  date.setDate(startOfWeek.getDate() + dayIndex);
                  return <div key={dayIndex}>{renderTimeCell(date, hour)}</div>;
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const renderMonthView = () => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDayOfMonth = new Date(year, month, 1).getDay();
    const now = new Date();
    const currentDayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );

    return (
      <div className="grid grid-cols-7 gap-0.5 md:gap-1 h-[calc(100vh-20rem)] md:h-[65vh] max-h-[600px]">
        {DAYS.map((day) => (
          <div
            key={day}
            className="text-center font-bold p-1 md:p-2 text-xs md:text-base"
          >
            {window.innerWidth < 768 ? day.slice(0, 1) : day}
          </div>
        ))}
        {Array.from({ length: firstDayOfMonth }, (_, i) => (
          <div key={`empty-${i}`} className="h-full bg-gray-50/50"></div>
        ))}
        {Array.from({ length: getDaysInMonth(currentDate) }, (_, i) => {
          const date = new Date(year, month, i + 1);
          const dateString = date.toISOString().split("T")[0];
          const daySlots =
            availableSlots?.filter((slot) => slot?.startsWith(dateString)) ||
            [];
          // console.log("daySlots", daySlots);
          const existingSlots =
            existingAppointments?.filter((slot) =>
              slot?.startsWith(dateString),
            ) || [];
          const selectedDaySlots =
            selectedSlots?.filter((slot) => slot?.startsWith(dateString)) || [];
          const isToday = date.getTime() === currentDayStart.getTime();
          const isPast = date < currentDayStart;

          return (
            <Card
              key={i}
              className={`h-full min-h-[60px] md:min-h-[100px] ${isToday ? "ring-2 ring-primary" : ""} ${isPast ? "bg-gray-50" : ""}`}
            >
              <CardContent className="p-0.5 md:p-1 h-full flex flex-col">
                <div
                  className={`font-bold bg-background/95 backdrop-blur p-1 flex justify-between items-center text-xs md:text-sm ${
                    isToday ? "text-primary" : ""
                  }`}
                >
                  <span>{i + 1}</span>
                  {daySlots.length > 0 && (
                    <Badge variant="outline" className="text-[10px] md:text-xs">
                      {daySlots.length}
                    </Badge>
                  )}
                </div>
                <div className="flex-1 space-y-0.5 md:space-y-1 mt-0.5 md:mt-1 overflow-y-auto scrollbar-thin">
                  {daySlots.map((slot, index) => {
                    const slotDate = new Date(slot);
                    const isInPast = slotDate < now;
                    const isSelected = selectedDaySlots.includes(slot);
                    const isExisting = existingSlots.includes(slot);

                    return (
                      <Button
                        key={index}
                        variant={isSelected ? "default" : "outline"}
                        size="sm"
                        className={`w-full h-5 md:h-6 text-[10px] md:text-xs justify-start ${
                          isExisting ? "bg-gray-200" : ""
                        } ${isInPast ? "opacity-50" : ""}`}
                        onClick={() => !isInPast && onSlotSelect(slot)}
                        disabled={isExisting || isInPast}
                      >
                        {slotDate.toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </Button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full max-w-[100vw] overflow-x-hidden">
      <div className="flex justify-between items-center mb-1 md:mb-4">
        <Button
          variant="outline"
          size="sm"
          onClick={navigatePrevious}
          className="p-1 md:p-2"
        >
          <ChevronLeft className="h-3 w-3 md:h-4 md:w-4" />
        </Button>
        <div className="text-sm md:text-lg font-bold truncate px-2">
          {currentDate.toLocaleDateString("en-US", {
            month: "long",
            year: "numeric",
          })}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={navigateNext}
          className="p-1 md:p-2"
        >
          <ChevronRight className="h-3 w-3 md:h-4 md:w-4" />
        </Button>
      </div>
      <div className="flex justify-end gap-1 md:gap-2 mb-1 md:mb-2">
        <Button
          variant={view === "week" ? "default" : "outline"}
          size="sm"
          onClick={() => setView("week")}
          className="text-xs md:text-sm px-2 md:px-3"
        >
          Week
        </Button>
        <Button
          variant={view === "month" ? "default" : "outline"}
          size="sm"
          onClick={() => setView("month")}
          className="text-xs md:text-sm px-2 md:px-3"
        >
          Month
        </Button>
      </div>
      {view === "week" ? renderWeekView() : renderMonthView()}
      <div className="mt-1 md:mt-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-1 md:gap-0">
          <div className="text-xs md:text-sm">
            Selected: {selectedSlots.length} / {requiredSlots}
          </div>
          <div className="text-xs md:text-sm text-muted-foreground">
            {new Date().toLocaleTimeString('en-us', { timeZoneName: 'short' }).split(' ')[2]}
          </div>
        </div>
      </div>
    </div>
  );
}
