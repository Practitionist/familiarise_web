// Data fetching functions using relative URLs
// These work in both client and server components
import { TConsultantProfile } from "@/types/consultant";
import { TConsulteeProfile } from "@/types/consultee";
import { TStaffProfile } from "@/types/staff";
import { TUserWithProfessionalBackground } from "@/types/user";
import type { TConsultantReview } from "@/types/review";

export const fetchUserDetails = async (
  userId: string,
): Promise<TUserWithProfessionalBackground> => {
  const response = await fetch(`/api/user/${userId}`);
  if (!response.ok) {
    const err = new Error(
      `Failed to fetch user details: ${response.statusText}`,
    );
    (err as Error & { status?: number }).status = response.status;
    throw err;
  }
  const userData: { data: TUserWithProfessionalBackground } =
    await response.json();
  return userData.data;
};

export const fetchConsultantDetails = async (
  consultantId: string,
): Promise<TConsultantProfile> => {
  const response = await fetch(`/api/user/consultants/${consultantId}`);
  if (!response.ok)
    throw new Error(
      `Failed to fetch consultant details: ${response.statusText}`,
    );
  const consultantData: { data: TConsultantProfile } = await response.json();
  return consultantData.data;
};

export const fetchConsulteeDetails = async (
  consulteeId: string,
): Promise<TConsulteeProfile> => {
  const response = await fetch(`/api/user/consultees/${consulteeId}`);
  if (!response.ok)
    throw new Error(
      `Failed to fetch consultee details: ${response.statusText}`,
    );
  const consulteeData: { data: TConsulteeProfile } = await response.json();
  return consulteeData.data;
};

export const fetchStaffDetails = async (
  staffId: string,
): Promise<TStaffProfile> => {
  const response = await fetch(`/api/user/staff/${staffId}`);
  if (!response.ok)
    throw new Error(`Failed to fetch staff details: ${response.statusText}`);
  const staffData: { data: TStaffProfile } = await response.json();
  return staffData.data;
};

export const fetchReviews = async (
  consultantId: string,
): Promise<TConsultantReview[]> => {
  const response = await fetch(
    `/api/user/reviews?consultantId=${consultantId}`,
  );
  if (!response.ok)
    throw new Error(`Failed to fetch reviews: ${response.statusText}`);
  const reviewsData: { data: TConsultantReview[] } = await response.json();
  return reviewsData.data;
};

/**
 * Maps application user roles to Stream Chat roles
 *
 * Standard Stream Chat roles:
 * - admin: Full permissions (create, read, update, delete channels)
 * - user: Basic user permissions (but may not have team channel access by default)
 * - guest: Limited permissions
 * - anonymous: Very limited permissions
 *
 * For now, using admin for consultants and consultees to ensure team channel access.
 * This can be refined later with custom roles configured in Stream Chat dashboard.
 *
 * @param role The application user role
 * @returns The corresponding Stream Chat role
 */
export function mapRoleToStream(role: string | null | undefined): string {
  if (!role) return "admin"; // Default to admin for team channel access

  switch (role.toUpperCase()) {
    case "ADMIN":
      return "admin";
    case "CONSULTANT":
      // Consultants need to create and manage their event channels
      return "admin";
    case "CONSULTEE":
      // Consultees need to read and participate in team channels they join
      return "admin";
    case "USER":
      return "admin";
    default:
      return "admin";
  }
}
