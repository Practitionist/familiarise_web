/**
 * Shared types for the platform-feedback API responses (feedback ABOUT the
 * product, triaged by staff — not a rating of a call, #1554).
 * Used by the staff feedback page and its API routes.
 */

import type { PlatformFeedbackStatus } from "@prisma/client";

export interface FeedbackUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  phone?: string | null;
  createdAt?: string;
}

export interface PlatformFeedback {
  id: string;
  title: string;
  description: string;
  rating: number | null;
  category: string | null;
  status: PlatformFeedbackStatus;
  user: FeedbackUser;
  createdAt: string;
  updatedAt: string;
}

export interface FeedbackCounts {
  total: number;
  pending: number;
  acknowledged: number;
  inProgress: number;
  resolved: number;
  closed: number;
}
