import type {
  ConflictDetail,
  SlotConflictResult,
} from "@/utils/scheduling-engine/types";

type ConflictEntry = SlotConflictResult["conflicts"][number];

/**
 * What a validate route says about a conflicting booking, by viewer. The
 * event's own consultant is a party to every booking on their calendar, so
 * they see the booking id and the other party's name (the grid PR links it);
 * anyone else — an org admin, staff — keeps "Another user", because that
 * booking's content is not theirs (ADR 20).
 */
export function describeConflict(
  slot: string,
  detail: ConflictDetail | undefined,
  viewer: { userId: string; isEventConsultant: boolean },
  fallbackType: string,
): ConflictEntry {
  const time = new Date(slot).toLocaleString();
  if (!detail || !viewer.isEventConsultant) {
    return {
      slot,
      existingAppointment: {
        type: detail?.type ?? fallbackType,
        with: "Another user",
        time,
      },
    };
  }
  const other = detail.otherParty;
  let withWhom = "Another user";
  if (other?.userId === viewer.userId) withWhom = "You (as a consultee)";
  else if (other?.name) withWhom = other.name;
  return {
    slot,
    existingAppointment: {
      type: detail.type,
      with: withWhom,
      time,
      appointmentId: detail.appointmentId,
    },
  };
}

/** Index the validator's structured conflicts by their seconds-precision slot. */
export function conflictDetailsBySlot(
  details: ConflictDetail[] | undefined,
): Map<string, ConflictDetail> {
  return new Map((details ?? []).map((d) => [d.slot, d]));
}
