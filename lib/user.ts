// Data fetching functions using relative URLs
// These work in both client and server components
import { TConsultantProfile } from "@/types/consultant";
import { TConsulteeProfile } from "@/types/consultee";
import { TUserWithProfessionalBackground } from "@/types/user";

export const fetchUserDetails = async (
  userId: string,
): Promise<TUserWithProfessionalBackground> => {
  const response = await fetch(`/api/user/${userId}`);
  if (!response.ok) {
    const err: Error & { status?: number } = new Error(
      `Failed to fetch user details: ${response.statusText}`,
    );
    err.status = response.status;
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

/**
 * Maps application user roles to Stream Chat roles.
 *
 * Every account, staff and admin included, is a plain Stream `user`; operator
 * chat access goes through audited server routes, never a browser client.
 * Hosts get channel-scoped `channel_moderator` on their own channels at
 * creation time instead of a global grant.
 *
 * @param _role The application user role (unused: every role maps to `user`)
 * @returns The corresponding Stream Chat role
 */
export function mapRoleToStream(_role: string | null | undefined): string {
  return "user";
}
