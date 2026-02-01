/**
 * Shared types for Feedback API responses.
 * Used by admin/feedback page and its API routes.
 */

import type { FeedbackStatus } from "@prisma/client";

export interface FeedbackUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  phone?: string | null;
  createdAt?: string;
}

export interface Feedback {
  id: string;
  title: string;
  description: string;
  rating: number | null;
  category: string | null;
  status: FeedbackStatus;
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
