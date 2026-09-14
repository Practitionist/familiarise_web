import type {
  TConsultationWithPlan,
  TSubscriptionWithPlan,
  TWebinarWithPlan,
  TCohortWithPlan,
  TTrialWithPlan,
} from "@/hooks/useEvents";

/**
 * Types for the consultee events API response
 * Matches the Prisma queries in /api/dashboard/consultee/[consulteeId]/events/route.ts
 *
 * Extends base types from hooks/useEvents with collaborator data
 * that the events API returns but the base types don't include.
 */

// Collaborator shape returned by the events API
interface ConsulteeCollaborator {
  consultantProfile: {
    user: { id: string; name: string; image: string | null };
  } | null;
  role: string;
}

// Extended webinar type with collaborators from the events API
export type TConsulteeWebinar = TWebinarWithPlan & {
  webinarPlan: {
    collaborators?: ConsulteeCollaborator[];
  };
};

// Extended class type with collaborators from the events API
export type TConsulteeCohort = TCohortWithPlan & {
  cohortPlan: {
    collaborators?: ConsulteeCollaborator[];
  };
};

// Full API response type
export interface TConsulteeEventsResponse {
  consultations: TConsultationWithPlan[];
  subscriptions: TSubscriptionWithPlan[];
  webinars: TConsulteeWebinar[];
  cohorts: TConsulteeCohort[];
  trials: TTrialWithPlan[];
}
