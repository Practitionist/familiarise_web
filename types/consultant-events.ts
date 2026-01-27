import { TAppointment } from "@/types/appointment";

/**
 * Types for the consultant dashboard API response
 * Matches the API in /api/dashboard/consultant/[consultantId]/route.ts
 *
 * Naming convention: T prefix for types (e.g., TConsultantActivity)
 */

// Activity type for recent client activities
// Matches the API response from /api/dashboard/consultant/[consultantId]/route.ts
export interface TConsultantActivity {
  id: string;
  type: string;
  description: string;
  actorId: string;
  actorName: string;
  actorImage: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  timeAgo: string;
}

// Approval type for pending consultation/subscription requests
export interface TConsultantApproval {
  id: string;
  name: string;
  type: string;
  date: string;
  time: string;
}

// Full API response type for consultant dashboard
export interface TConsultantDashboardResponse {
  appointments: TAppointment[];
  activities: TConsultantActivity[];
  approvals: TConsultantApproval[];
}

// API wrapper response
export interface TConsultantDashboardApiResponse {
  data: TConsultantDashboardResponse;
  success: boolean;
  error?: string;
  message?: string;
}
