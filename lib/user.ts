// Server-side data fetching functions
import { User, ConsultantReview } from "@prisma/client";
import { TConsultantProfile } from "@/types/consultant";
import { TConsulteeProfile } from "@/types/consultee";
import { TStaffProfile } from "@/types/staff";

// Helper function to get the base URL for server-side API calls
const getBaseUrl = () => {
  // For server-side API calls in Next.js, we need to use absolute URLs
  // First try to get the base URL from environment variables
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return `https://${process.env.NEXT_PUBLIC_SITE_URL}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }

  // Default to localhost for development
  return "http://localhost:3000";
};

export const fetchUserDetails = async (userId: string): Promise<User> => {
  const baseUrl = getBaseUrl();
  const response = await fetch(`${baseUrl}/api/user/${userId}`);
  if (!response.ok)
    throw new Error(`Failed to fetch user details: ${response.statusText}`);
  const userData: { data: User } = await response.json();
  return userData.data;
};

export const fetchConsultantDetails = async (
  consultantId: string,
): Promise<TConsultantProfile> => {
  const baseUrl = getBaseUrl();
  const response = await fetch(
    `${baseUrl}/api/user/consultants/${consultantId}`,
  );
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
  const baseUrl = getBaseUrl();
  const response = await fetch(`${baseUrl}/api/user/consultees/${consulteeId}`);
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
  const baseUrl = getBaseUrl();
  const response = await fetch(`${baseUrl}/api/user/staff/${staffId}`);
  if (!response.ok)
    throw new Error(`Failed to fetch staff details: ${response.statusText}`);
  const staffData: { data: TStaffProfile } = await response.json();
  return staffData.data;
};

export const fetchReviews = async (
  consultantId: string,
): Promise<ConsultantReview[]> => {
  const baseUrl = getBaseUrl();
  const response = await fetch(
    `${baseUrl}/api/user/reviews?consultantId=${consultantId}`,
  );
  if (!response.ok)
    throw new Error(`Failed to fetch reviews: ${response.statusText}`);
  const reviewsData: { data: ConsultantReview[] } = await response.json();
  return reviewsData.data;
};

/**
 * Maps application user roles to Stream Chat roles
 *
 * Stream Chat roles and their typical permissions:
 * - admin: Full permissions (create, read, update, delete channels, manage users)
 * - moderator: Can moderate channels, ban users, delete messages
 * - user: Standard user permissions (join channels, send messages, read)
 * - guest: Limited permissions (often read-only or restricted sending)
 * - anonymous: Very limited permissions
 *
 * Note: For team channel access, users typically need 'user' role or higher.
 * Custom roles can be configured in Stream Chat dashboard for more granular control.
 *
 * @param role The application user role
 * @returns The corresponding Stream Chat role
 */
export function mapRoleToStream(role: string | null | undefined): string {
  if (!role) return "user"; // Default to user role for basic access

  switch (role.toUpperCase()) {
    case "ADMIN":
    case "STAFF":
      // System admins and staff get full admin permissions
      return "admin";
    case "CONSULTANT":
      // Consultants need to create and manage their event channels
      // but don't need full admin permissions for security
      return "moderator";
    case "CONSULTEE":
    case "USER":
      // Consultees and regular users get standard user permissions
      // This should allow team channel participation while limiting admin actions
      return "user";
    default:
      // Unknown roles get basic user permissions
      return "user";
  }
}

/**
 * Determines the appropriate display name for a user in chat contexts
 * Priority: consultee profile name → consultant profile name → account name → user ID
 * 
 * @param user The user object with potential profile information
 * @returns The most appropriate display name for chat interfaces
 */
export function getProfileDisplayName(user: {
  id: string;
  name?: string | null;
  consulteeProfile?: {
    user?: {
      name?: string | null;
    };
  } | null;
  consultantProfile?: {
    user?: {
      name?: string | null;
    };
  } | null;
}): string {
  // Priority order for name resolution:
  // 1. Consultee profile user name (for consultees in chat)
  // 2. Consultant profile user name (for consultants in chat) 
  // 3. Direct user account name
  // 4. User ID as final fallback
  
  const consulteeName = user.consulteeProfile?.user?.name;
  const consultantName = user.consultantProfile?.user?.name;
  const accountName = user.name;
  const userId = user.id;

  return consulteeName || consultantName || accountName || userId;
}
