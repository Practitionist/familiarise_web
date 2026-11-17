/**
 * What the collaborations screens receive. The shapes mirror
 * `GET /api/collaborations` and a plan's team list; check the route's select
 * before changing one.
 */

import type { CollaboratorRole } from "@prisma/client";

// ─── Shared schedule types ───────────────────────────────────────────────────

export interface SlotSchedule {
  startsAt: string;
  endsAt: string;
  isTentative: boolean;
}

/** Enrolment is counted on the appointment, not per occurrence. */
export interface AppointmentSchedule {
  occurrences: SlotSchedule[];
  _count: { participants: number };
}

export interface WebinarEventSchedule {
  id: string;
  status: string;
  appointment: AppointmentSchedule | null;
}

/** A class session carries what the batch card derivation reads. */
export interface ClassSlotSchedule extends SlotSchedule {
  ordinal: number;
  completionStatus: string;
  deletedAt: string | null;
}

/** One wrapper appointment per class batch. */
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

// ─── Team rows ───────────────────────────────────────────────────────────────

export type PlanType = "webinar" | "class";

export interface Person {
  name: string | null;
  image: string | null;
}

/** One invited or accepted collaborator of a plan, as a screen receives it. */
export interface TeamMember {
  id: string;
  role: CollaboratorRole;
  status: "PENDING" | "ACCEPTED";
  /** Null when the viewer may not see it: a collaborator sees only their own share. */
  revenueShareBps: number | null;
  /** When a pending invitation lapses; sent to a plan's manager and on the plan's own team list. */
  expiresAt?: string | null;
  consultantProfile: { id: string; user: Person };
}

// ─── Collaborator perspective types ──────────────────────────────────────────

export interface PlanOwner {
  id: string;
  user: Person;
}

/** The viewer's own invitation or place on a plan. */
export interface Collaboration {
  id: string;
  role: CollaboratorRole;
  revenueShareBps: number;
  status: "PENDING" | "ACCEPTED";
  createdAt: string;
  /** When the invitation was sent or its terms last changed; it lapses a fixed time after this. */
  updatedAt: string;
  payoutAccountReady?: boolean;
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
    collaborators: TeamMember[];
  } | null;
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
    collaborators: TeamMember[];
  } | null;
  invitedBy: { user: { name: string | null } } | null;
}

/** A collaboration flattened with its plan's type, id, title and price by the panel. */
export type CollaborationWithPlan = Collaboration & {
  planType: PlanType;
  planId: string;
  planTitle: string;
  planPrice: number;
};

// ─── Host perspective types ──────────────────────────────────────────────────

export interface HostedWebinarPlan {
  id: string;
  title: string;
  price: number;
  durationInHours: number;
  maxParticipants: number;
  language: string | null;
  level: string | null;
  /** The plan's host; absent on an organisation plan with no owning expert. */
  consultantProfile?: { user: Person } | null;
  collaborators: TeamMember[];
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
  /** The plan's host; absent on an organisation plan with no owning expert. */
  consultantProfile?: { user: Person } | null;
  collaborators: TeamMember[];
  classes: ClassEventSchedule[];
}

/** A hosted plan flattened to a uniform card entry by the panel. */
export interface HostedPlanEntry {
  planType: PlanType;
  planId: string;
  title: string;
  price: number;
  collaborators: TeamMember[];
  /** Set on the org-wide view, where the viewer is not the host. */
  host?: Person | null;
  webinarPlan?: HostedWebinarPlan;
  classPlan?: HostedClassPlan;
}

// ─── Combined data from API ──────────────────────────────────────────────────

export interface CollaborationsData {
  webinarCollaborations: Collaboration[];
  classCollaborations: Collaboration[];
  hostedWebinarPlans: HostedWebinarPlan[];
  hostedClassPlans: HostedClassPlan[];
  hostUser?: Person;
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
