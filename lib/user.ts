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
