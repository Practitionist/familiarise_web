import type { SlotOfAppointment } from "@prisma/client";

export const DEFAULT_MEETING_DURATION_MS = 60 * 60 * 1000;

export interface SlotWithMeetingSession extends SlotOfAppointment {
  meetingSession?: { id: string; endedAt: Date | string | null } | null;
}

export type SessionStatus = "completed" | "noRecord" | "upcoming" | "joinable";
