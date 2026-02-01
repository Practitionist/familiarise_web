/**
 * Shared types for Admin/Staff User Management API responses.
 * Used by admin/users and staff/users pages.
 */

export interface UserListItem {
  id: string;
  name: string | null;
  email: string | null;
  role: string;
  onboardingCompleted: boolean | null;
  createdAt: string;
  image?: string | null;
  phone?: string | null;
  city?: string | null;
  country?: string | null;
}

export interface UserListResponse {
  users: UserListItem[];
  total: number;
  page: number;
  totalPages: number;
}
