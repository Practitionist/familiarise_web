import { TAppointment } from "@/types/appointment";

/**
 * Types for the consultant dashboard API response
 * Matches the API in /api/dashboard/consultant/[consultantId]/route.ts
 *
 * Naming convention: T prefix for types (e.g., TConsultantActivity)
 */

// Activity type for recent client activities
export interface TConsultantActivity {
  id: string;
  name: string;
  action: string;
  time: string;
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
