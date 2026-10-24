import type { Tx } from "@/lib/prisma";

/**
 * Closes one room segment's open device stays at its end stamp. The close is an
 * assumption (`closedByEnd`), so the outcome sweep asks Stream for the real leave;
 * rows written before segments were recorded (null call id) close with any end.
 */
export function closeSegmentPresences(
  db: Pick<Tx, "meetingPresence">,
  args: { meetingId: string; streamCallId: string; endedAt: Date },
) {
  return db.meetingPresence.updateMany({
    where: {
      meetingId: args.meetingId,
      leftAt: null,
      OR: [{ streamCallId: args.streamCallId }, { streamCallId: null }],
    },
    data: { leftAt: args.endedAt, closedByEnd: true },
  });
}
