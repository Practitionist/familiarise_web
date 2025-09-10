import { SafeUnifiedCalendar } from "../../shared/components/SafeUnifiedCalendar";
import { TimeSlot } from "../../shared/utils/calendarUtils";

type TimingsCalendarProps = {
  consultantId: string;
  eventType: "consultation" | "subscription";
  eventId?: string;
  onSlotSelect: (slotStartTimeUTC: string) => void;
  selectedSlots?: string[];
  requiredSlots: number;
  durationInMonths?: number;
  callsPerWeek?: number;
  durationInHours?: number;
  sessionDurationInHours?: number;
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
  durationInHours,
  sessionDurationInHours,
}: TimingsCalendarProps) {
  const handleSlotsSelected = (slots: TimeSlot[]) => {
    // Diff-based updates to avoid toggle thrashing and render loops
    const newSet = new Set(slots.map((s) => s.startTime.toISOString()));
    const prevSet = new Set(selectedSlots || []);

    // Add newly selected
    for (const iso of newSet) {
      if (!prevSet.has(iso)) onSlotSelect(iso);
    }

    // Remove deselected
    for (const iso of prevSet) {
      if (!newSet.has(iso)) onSlotSelect(iso);
    }
  };

  return (
    <SafeUnifiedCalendar
      consultantId={consultantId}
      eventType={eventType}
      eventId={eventId}
      durationInMonths={durationInMonths}
      durationInHours={durationInHours}
      sessionDurationInHours={sessionDurationInHours}
      callsPerWeek={callsPerWeek}
      mode="select"
      onSlotsSelected={handleSlotsSelected}
      className="h-full"
    />
  );
}
