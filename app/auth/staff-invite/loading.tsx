import { AuthCardSkeleton } from "../AuthCardSkeleton";

/**
 * #1927 — the staff-invite route streams, so the skeleton is the loading
 * boundary. Matches verify-email / reset-password.
 */
export default function StaffInviteLoading() {
  return <AuthCardSkeleton />;
}
