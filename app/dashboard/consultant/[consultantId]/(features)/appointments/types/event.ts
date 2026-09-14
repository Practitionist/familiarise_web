interface User {
  id: string;
  name?: string;
  email?: string;
}

interface AppointmentOccurrence {
  id: string;
  startsAt: Date;
  endsAt: Date;
  user: User[];
}

interface Appointment {
  id: string;
  occurrences: AppointmentOccurrence[];
}

interface CohortPlan {
  id: string;
  title: string;
  maxParticipants: number;
}

export interface CohortEvent {
  id: string;
  /** Per-instance capacity; null inherits the plan's value. */
  maxParticipants: number | null;
  cohortPlan: CohortPlan;
  appointments: Appointment[];
}

interface WebinarPlan {
  id: string;
  title: string;
  maxParticipants: number;
}

export interface WebinarEvent {
  id: string;
  /** Per-instance capacity; null inherits the plan's value. */
  maxParticipants: number | null;
  webinarPlan: WebinarPlan;
  appointment: Appointment | null;
}
