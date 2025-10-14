import { SafeUnifiedCalendar } from "../../shared/components/SafeUnifiedCalendar";
import { TimeSlot } from "../../shared/utils/calendarUtils";

type TimingsCalendarProps = {
  consultantId: string;
  eventType: "consultation" | "subscription";
  eventId?: string;
  onSlotSelect: (slotStartTimeUTC: string) => void;
  onSlotsChange?: (slots: string[]) => void; // New prop for bulk updates
  selectedSlots: string[] | undefined;
  requiredSlots: number;
  durationInMonths?: number;
  durationInHours?: number; // For consultations
  callsPerWeek?: number;
  sessionDurationInHours?: number; // For subscriptions
  allowedStart?: Date;
  allowedEnd?: Date;
};

export function TimingsCalendar({
  consultantId,
  eventType,
  eventId,
  onSlotSelect,
  onSlotsChange,
  selectedSlots = [],
  requiredSlots: _requiredSlots, // Used by parent for validation
  durationInMonths,
  durationInHours,
  callsPerWeek,
  sessionDurationInHours,
  allowedStart,
  allowedEnd,
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
    // FIX BUG #3: Use bulk update callback if available to avoid state desync
    // The issue was that iterating and calling onSlotSelect for each slot caused
    // the parent to toggle slots individually, resulting in mismatched state
    if (onSlotsChange) {
      // Convert TimeSlot objects to ISO strings and set all at once
      const slotStrings = slots.map((slot) => slot.startTime.toISOString());
      onSlotsChange(slotStrings);
    } else {
      // Fallback to individual slot toggling (legacy behavior)
      slots.forEach((slot) => {
        onSlotSelect(slot.startTime.toISOString());
      });
    }
  };

  return (
    <SafeUnifiedCalendar
      consultantId={consultantId}
      eventType={eventType}
      eventId={eventId}
      durationInMonths={durationInMonths}
      durationInHours={durationInHours}
      callsPerWeek={callsPerWeek}
      sessionDurationInHours={sessionDurationInHours}
      mode="select"
      onSlotsSelected={handleSlotsSelected}
      preSelectedSlots={convertToTimeSlots(selectedSlots)}
      showAllocationButtons={false}
      allowedStart={allowedStart}
      allowedEnd={allowedEnd}
      className="h-full"
    />
  );
}
