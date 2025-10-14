import { SafeUnifiedCalendar } from "../../shared/components/SafeUnifiedCalendar";
import { TimeSlot } from "../../shared/utils/calendarUtils";

type TimingsCalendarProps = {
  consultantId: string;
  eventType: "consultation" | "subscription";
  eventId?: string;
  onSlotSelect: (slotStartTimeUTC: string) => void;
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
    // Convert TimeSlot objects back to ISO strings for the parent component
    slots.forEach((slot) => {
      onSlotSelect(slot.startTime.toISOString());
    });
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
