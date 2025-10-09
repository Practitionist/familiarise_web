import { RequestStatus, ScheduleType } from "@prisma/client";

// --- API Response Type Definitions ---
export interface UserInfo {
  id: string;
  name: string;
  image?: string;
}

export interface RequestedBy {
  id: string;
  user: UserInfo;
}

export interface ConsultationPlanInfo {
  title?: string;
  durationInHours?: number;
}

export interface SubscriptionPlanInfo {
  title?: string;
  callsPerWeek: number;
  durationInMonths: number;
  sessionDurationInHours: number;
}

export interface AppointmentSlot {
  id: string;
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
}

export interface AppointmentInfo {
  id: string;
  slotsOfAppointment?: AppointmentSlot[];
}

export interface ConsultationApiResponse {
  id: string;
  consultationPlan?: ConsultationPlanInfo;
  requestedBy: RequestedBy;
  requestedAt: string;
  appointment?: AppointmentInfo;
  requestStatus: RequestStatus;
}

export interface SubscriptionApiResponse {
  id: string;
  subscriptionPlan?: SubscriptionPlanInfo;
  requestedBy: RequestedBy;
  requestedAt: string;
  appointments?: AppointmentInfo[];
  requestStatus: RequestStatus;
  startDate?: string;
  endDate?: string;
}

export interface AvailabilityApiResponse extends AppointmentSlot {}

export interface ConsultantApiResponse {
  scheduleType?: ScheduleType;
  user?: {
    currentTimezone?: string;
  };
}

// Interface used within the component
export interface SlotInterval {
  id: string;
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
}
