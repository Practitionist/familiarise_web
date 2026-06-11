import type { TSlotOfAppointment } from "@/types/appointment";

const JOIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes before start
const DEFAULT_MEETING_DURATION_MS = 60 * 60 * 1000; // 1 hour fallback

type JoinState = "disabled" | "countdown" | "joinable" | "ended";

function getSlotJoinState(slot: TSlotOfAppointment): JoinState {
  if (slot.isTentative) return "disabled";
  if (
    slot.completionStatus === "CANCELLED" ||
    slot.completionStatus === "RESCHEDULED"
  )
    return "disabled";

  // Session manually ended early by consultant
  if (slot.meetingSession?.endedAt) return "ended";

  const now = Date.now();
  const start = new Date(slot.startsAt).getTime();
  const end = slot.endsAt
    ? new Date(slot.endsAt).getTime()
    : start + DEFAULT_MEETING_DURATION_MS;
  const joinWindow = start - JOIN_WINDOW_MS;

  if (now > end) return "ended";
  if (now >= joinWindow) return "joinable";
  return "countdown";
}

export function getJoinableSlot(
  slots: TSlotOfAppointment[],
): TSlotOfAppointment | null {
  const sorted = [...slots].sort(
    (a, b) =>
      new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
  for (const slot of sorted) {
    if (getSlotJoinState(slot) === "joinable") return slot;
  }
  return null;
}
