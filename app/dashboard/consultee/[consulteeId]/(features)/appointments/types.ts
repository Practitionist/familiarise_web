import type { SlotOfAppointment } from "@prisma/client";

export interface SlotWithMeetingSession extends SlotOfAppointment {
  meetingSession?: { id: string; endedAt: Date | string | null } | null;
}

export type SessionStatus = "completed" | "noRecord" | "upcoming" | "joinable";
