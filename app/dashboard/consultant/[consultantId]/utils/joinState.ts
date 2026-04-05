import type { TSlotOfAppointment } from "@/types/appointment";

const JOIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes before start

export type JoinState = "disabled" | "countdown" | "joinable" | "ended";

export function getSlotJoinState(slot: TSlotOfAppointment): JoinState {
  if (slot.isTentative) return "disabled";
  if (
    slot.completionStatus === "CANCELLED" ||
    slot.completionStatus === "RESCHEDULED"
  )
    return "disabled";

  const now = Date.now();
  const start = new Date(slot.startsAt).getTime();
  const end = new Date(slot.endsAt).getTime();
  const joinWindow = start - JOIN_WINDOW_MS;

  if (now > end) return "ended";
  if (now >= joinWindow) return "joinable";
  return "countdown";
}

export function getJoinableSlot(
  slots: TSlotOfAppointment[],
): TSlotOfAppointment | null {
  for (const slot of slots) {
    if (getSlotJoinState(slot) === "joinable") return slot;
  }
  return null;
}
