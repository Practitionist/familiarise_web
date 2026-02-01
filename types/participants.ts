/**
 * Shared types for Participant API responses.
 * Used by consultant participant pages (consultation, subscription, webinar, class).
 */

/** User info in participant lists — shared by consultation + subscription participant pages. */
export interface ParticipantUser {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

/** Waitlist entry in participant views — shared by webinar + class participant pages. */
export interface WaitlistParticipant {
  id: string;
  user: {
    id: string;
    name: string | null;
    email: string | null;
    image: string | null;
  };
  joinedAt: string;
  status: string;
  position: number | null;
}
