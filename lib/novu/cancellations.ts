import { ANNOUNCEMENT_CANCELLATION_REASONS } from "@/schemas/announcements";

export const EXPECTED_NOTIFICATION_CANCELLATIONS = [
  ...ANNOUNCEMENT_CANCELLATION_REASONS,
  "recipient:audience_changed",
] as const;
