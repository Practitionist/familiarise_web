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
  const [sessionDuration, setSessionDuration] = useState<number>(1); // Default 1 hour

  // Fetch session duration based on event type and ID
  useEffect(() => {
    const fetchSessionDuration = async () => {
      if (!eventId) {
        setSessionDuration(1); // Default fallback
        return;
      }

      try {
        const endpoint = eventType === "consultation" 
          ? `/api/events/consultations/${eventId}` 
          : `/api/events/subscriptions/${eventId}`;
        
        const response = await fetch(endpoint);
        if (response.ok) {
          const data = await response.json();
          
          if (eventType === "consultation") {
            setSessionDuration(data.consultationPlan?.durationInHours || 1);
          } else {
            setSessionDuration(data.subscriptionPlan?.sessionDurationInHours || 1);
          }
        }
      } catch (error) {
        console.warn("Failed to fetch session duration, using default:", error);
        setSessionDuration(1);
      }
    };

    fetchSessionDuration();
  }, [eventId, eventType]);
  // Convert string slots to TimeSlot objects for the unified calendar
  const convertToTimeSlots = (slotStrings: string[]): TimeSlot[] => {
    return slotStrings.map(slotString => {
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
    slots.forEach(slot => {
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
      sessionDurationInHours={sessionDuration}
      mode="select"
      onSlotsSelected={handleSlotsSelected}
      preSelectedSlots={convertToTimeSlots(selectedSlots)}
      className="h-full"
    />
  );
}
