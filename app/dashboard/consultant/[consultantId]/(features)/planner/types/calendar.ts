import { TCustomSlot, TWeeklySlot } from "@/types/slots";

export interface TimeSlot {
  startTime: Date;
  endTime: Date;
  isAvailable: boolean;
  isBooked: boolean;
  originalSlot?: TWeeklySlot | TCustomSlot;
}

export interface AppointmentSlot {
  startsAt: string | Date;
  endsAt: string | Date;
}

export interface Appointment {
  id: string;
  appointmentType: string;
  slotsOfAppointment?: AppointmentSlot[];
  webinar?: { status: string };
  class?: { status: string };
}

export interface ConsultantData {
  scheduleType: "WEEKLY" | "CUSTOM";
  slotsOfAvailabilityWeekly: TWeeklySlot[];
  slotsOfAvailabilityCustom: TCustomSlot[];
}
