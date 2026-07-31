/**
 * Type definitions for Planner Service API request payloads
 *
 * NOTE: Response types should use Prisma types directly:
 * - TWebinar, TClass from @/types/appointment.ts
 * - ConsultationPlan, SubscriptionPlan from @/schemas/plans.ts (Zod-inferred)
 *
 * These payload types are for API requests only.
 */

import { PlanEmailSupport } from "@prisma/client";

// Request payload types for creating/updating entities

export interface CreateWebinarPayload {
  title: string;
  description?: string;
  price: number;
  priceCurrency?: string;
  durationInHours: number;
  maxParticipants: number;
  certificateProvided?: boolean;
  recordingEnabled?: boolean;
  language?: string;
  level?: string;
  prerequisites?: string;
  materialProvided?: string;
  learningOutcomes?: string[];
  topics?: string[];
  consultantProfileId: string;
  scheduledAt?: Date | string | null;
}

export interface CreateClassPayload {
  title: string;
  description: string;
  price: number;
  priceCurrency?: string;
  durationInMonths: number;
  sessionsPerWeek: number;
  maxParticipants: number;
  certificateProvided?: boolean;
  recordingEnabled?: boolean;
  emailSupport?: PlanEmailSupport;
  language?: string;
  level?: string;
  prerequisites?: string;
  materialProvided?: string;
  learningOutcomes?: string[];
  topics?: string[];
  classContents?: ClassContentInput[];
  consultantProfileId: string;
  startDate?: string;
}

export interface ClassContentInput {
  id?: string;
  title: string;
  description: string;
  contentType?: string | null;
  contentUrl?: string | null;
  order: number;
  hoursAllotted: number;
}

// Update payload types extend create types with optional id fields
export interface UpdateClassPayload extends CreateClassPayload {
  id: string;
  classId?: string;
}

export interface UpdateWebinarPayload extends CreateWebinarPayload {
  id: string;
  webinarId?: string;
}

// Union types for request bodies
export type ClassRequestBody = CreateClassPayload | UpdateClassPayload;
export type WebinarRequestBody = CreateWebinarPayload | UpdateWebinarPayload;
