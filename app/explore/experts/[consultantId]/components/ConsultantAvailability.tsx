import { TConsultantProfile } from "@/types/consultant";
import { TSlotTiming } from "@/types/slots";
import { WeeklyAvailability } from "./WeeklyAvailability";
import { CustomAvailability } from "./CustomAvailability";
import { 
  normalizeWeeklySlot, 
  normalizeCustomSlot, 
  formatTime,
  dayMap 
} from "../utils";

interface ConsultantAvailabilityProps {
  consultantDetails: TConsultantProfile;
  selectedSlot: TSlotTiming | null;
  setSelectedSlot: (slot: TSlotTiming | null) => void;
  timezone: string;
}

export function ConsultantAvailability({
  consultantDetails,
  selectedSlot,
  setSelectedSlot,
  timezone
}: ConsultantAvailabilityProps) {
  return (
    <div>
      <h3 className="text-xl font-semibold mb-4">Consultant Availability</h3>
      <p className="text-sm text-gray-600 mb-4">
        {consultantDetails.scheduleType === "WEEKLY"
          ? "Weekly schedule. Select a time slot to schedule a meeting."
          : "Custom schedule for the next 7 days. Select a time slot to schedule a meeting."}
      </p>
      
      {consultantDetails.scheduleType === "WEEKLY" ? (
        <WeeklyAvailability
          slots={consultantDetails.slotsOfAvailabilityWeekly.map(normalizeWeeklySlot)}
          onSlotSelect={slot => {
            const normalizedSlot = normalizeWeeklySlot(slot);
            setSelectedSlot({
              slotId: normalizedSlot.id,
              dateInISO: new Date().toISOString(),
              dayOfWeek: normalizedSlot.dayOfWeekforStartTimeInUTC,
              slotStartTimeInUTC: normalizedSlot.slotStartTimeInUTC,
              slotEndTimeInUTC: normalizedSlot.slotEndTimeInUTC,
              slotOfAvailabilityId: normalizedSlot.id,
              slotOfAppointmentId: "",
              localStartTime: formatTime(normalizedSlot.slotStartTimeInUTC, timezone),
              localEndTime: formatTime(normalizedSlot.slotEndTimeInUTC, timezone),
            });
          }}
          selectedSlotId={selectedSlot?.slotId}
        />
      ) : (
        <CustomAvailability
          slots={consultantDetails.slotsOfAvailabilityCustom.map(normalizeCustomSlot)}
          onSlotSelect={slot => {
            const normalizedSlot = normalizeCustomSlot(slot);
            setSelectedSlot({
              slotId: normalizedSlot.id,
              dateInISO: new Date(normalizedSlot.slotStartTimeInUTC).toISOString(),
              dayOfWeek: dayMap[new Date(normalizedSlot.slotStartTimeInUTC).getDay()],
              slotStartTimeInUTC: normalizedSlot.slotStartTimeInUTC,
              slotEndTimeInUTC: normalizedSlot.slotEndTimeInUTC,
              slotOfAvailabilityId: normalizedSlot.id,
              slotOfAppointmentId: "",
              localStartTime: formatTime(normalizedSlot.slotStartTimeInUTC, timezone),
              localEndTime: formatTime(normalizedSlot.slotEndTimeInUTC, timezone),
            });
          }}
          selectedSlotId={selectedSlot?.slotId}
        />
      )}
    </div>
  );
}
