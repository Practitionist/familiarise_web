import { UnifiedCalendar } from "../../shared/components/UnifiedCalendar";
import { TimeSlot } from "../../shared/utils/calendarUtils";
import { useEffect, useState } from "react";

type TimingsCalendarProps = {
  consultantId: string;
  eventType: "consultation" | "subscription";
  eventId?: string;
  onSlotSelect: (slotStartTimeUTC: string) => void;
  selectedSlots: string[] | undefined;
  requiredSlots: number;
  durationInMonths?: number;
  callsPerWeek?: number;
};

export function TimingsCalendar({
  consultantId,
  eventType,
  eventId,
  onSlotSelect,
  selectedSlots = [],
  requiredSlots,
  durationInMonths,
  callsPerWeek,
}: TimingsCalendarProps) {
  // Convert string slots to TimeSlot objects for the unified calendar
  const convertToTimeSlots = (slotStrings: string[]): TimeSlot[] => {
    return slotStrings.map((slotString) => {
      const startTime = new Date(slotString);
      const endTime = new Date(startTime.getTime() + 30 * 60 * 1000); // 30 minutes later
      return {
        startTime,
        endTime,
        isAvailable: true,
        isBooked: false,
      };
    });
  };

  const handleSlotsSelected = (slots: TimeSlot[]) => {
    // Convert TimeSlot objects back to ISO strings for the parent component
    slots.forEach((slot) => {
      onSlotSelect(slot.startTime.toISOString());
    });
  };

  return (
    <UnifiedCalendar
      consultantId={consultantId}
      eventType={eventType}
      eventId={eventId}
      durationInMonths={durationInMonths}
      callsPerWeek={callsPerWeek}
      mode="select"
      onSlotsSelected={handleSlotsSelected}
      preSelectedSlots={convertToTimeSlots(selectedSlots)}
      className="h-full"
    />
  );
}
