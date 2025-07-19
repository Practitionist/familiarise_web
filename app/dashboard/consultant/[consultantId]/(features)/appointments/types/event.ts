export interface User {
  id: string;
  name?: string;
  email?: string;
}

export interface SlotOfAppointment {
  id: string;
  slotStartTimeInUTC: Date;
  slotEndTimeInUTC: Date;
  user: User[];
}

export interface Appointment {
  id: string;
  slotsOfAppointment: SlotOfAppointment[];
}

export interface ClassPlan {
  id: string;
  title: string;
  maxParticipants: number;
}

export interface ClassEvent {
  id: string;
  classPlan: ClassPlan;
  appointments: Appointment[];
}

export interface WebinarPlan {
  id: string;
  title: string;
  maxParticipants: number;
}

export interface WebinarEvent {
  id: string;
  webinarPlan: WebinarPlan;
  appointment: Appointment | null;
}
