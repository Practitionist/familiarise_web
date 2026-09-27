/**
 * Shared types for the collaborations surface (InvitationsPanel and its
 * extracted cards). Shapes mirror `GET /api/collaborations` exactly —
 * do not widen/narrow without checking the route's select.
 */

// ─── Shared schedule types ───────────────────────────────────────────────────

export interface SlotSchedule {
  startsAt: string;
  endsAt: string;
  isTentative: boolean;
}

/** Enrolment is counted on the appointment (#1554), not per occurrence. */
export interface AppointmentSchedule {
  occurrences: SlotSchedule[];
  _count: { participants: number };
}

export interface WebinarEventSchedule {
  id: string;
  status: string;
  appointment: AppointmentSchedule | null;
}

/** #1819 — a class session carries what the batch card derivation reads. */
export interface ClassSlotSchedule extends SlotSchedule {
  ordinal: number;
  completionStatus: string;
  deletedAt: string | null;
}

/** #1554 — one wrapper appointment per class batch. */
export interface ClassEventSchedule {
  id: string;
  status: string;
  schedulingPeriodStartsAt: string | null;
  schedulingPeriodEndsAt: string | null;
  appointment: {
    occurrences: ClassSlotSchedule[];
    _count: { participants: number };
  } | null;
}

// ─── Collaborator perspective types ──────────────────────────────────────────

export interface PlanOwner {
  id: string;
  user: { name: string | null; image: string | null };
}

export interface PlanCollaboratorInfo {
  id: string;
  role: string;
  revenueShareBps: number;
  status: "PENDING" | "ACCEPTED";
  consultantProfile: {
    id: string;
    user: { name: string | null; image: string | null };
  };
}

export interface Collaboration {
  id: string;
  role: string;
  revenueShareBps: number;
  status: "PENDING" | "ACCEPTED";
  createdAt: string;
  webinarPlan?: {
    id: string;
    title: string;
    price: number;
    durationInHours: number;
    maxParticipants: number;
    language: string | null;
    level: string | null;
    webinars: WebinarEventSchedule[];
    consultantProfile: PlanOwner | null;
    collaborators: PlanCollaboratorInfo[];
  };
  classPlan?: {
    id: string;
    title: string;
    price: number;
    sessionDurationInHours: number;
    maxParticipants: number;
    sessionsPerWeek: number;
    durationInMonths: number;
    totalSessions: number;
    lateJoinUntilSession: number | null;
    classes: ClassEventSchedule[];
    consultantProfile: PlanOwner | null;
    collaborators: PlanCollaboratorInfo[];
  };
  invitedBy: {
    user: { name: string | null };
  };
}

/** A collaboration flattened with its plan type/title/price by the panel. */
export type CollaborationWithPlan = Collaboration & {
  planType: "webinar" | "class";
  planTitle: string;
  planPrice: number;
};

// ─── Host perspective types ──────────────────────────────────────────────────

export interface CollaboratorInfo {
  id: string;
  role: string;
  revenueShareBps: number;
  status: "PENDING" | "ACCEPTED";
  consultantProfile: {
    id: string;
    user: { name: string | null; image: string | null };
  };
}

export interface HostedWebinarPlan {
  id: string;
  title: string;
  price: number;
  durationInHours: number;
  maxParticipants: number;
  language: string | null;
  level: string | null;
  collaborators: CollaboratorInfo[];
  webinars: WebinarEventSchedule[];
}

export interface HostedClassPlan {
  id: string;
  title: string;
  price: number;
  sessionDurationInHours: number;
  maxParticipants: number;
  sessionsPerWeek: number;
  durationInMonths: number;
  totalSessions: number;
  lateJoinUntilSession: number | null;
  collaborators: CollaboratorInfo[];
  classes: ClassEventSchedule[];
}

/** A hosted plan flattened to a uniform card entry by the panel. */
export interface HostedPlanEntry {
  planType: "webinar" | "class";
  title: string;
  price: number;
  collaborators: CollaboratorInfo[];
  webinarPlan?: HostedWebinarPlan;
  classPlan?: HostedClassPlan;
}

// ─── Combined data from API ──────────────────────────────────────────────────

export interface CollaborationsData {
  webinarCollaborations: Collaboration[];
  classCollaborations: Collaboration[];
  hostedWebinarPlans: HostedWebinarPlan[];
  hostedClassPlans: HostedClassPlan[];
  hostUser?: { name: string | null; image: string | null };
}

// ─── Structural subsets consumed by the schedule summary components ─────────

export interface WebinarPlanSchedule {
  durationInHours: number;
  maxParticipants: number;
  webinars: WebinarEventSchedule[];
}

export interface ClassPlanSchedule {
  price: number;
  sessionDurationInHours: number;
  maxParticipants: number;
  sessionsPerWeek: number;
  totalSessions: number;
  lateJoinUntilSession: number | null;
  classes: ClassEventSchedule[];
}
