import type { Tx } from "@/lib/prisma";

type SegmentEnd = { meetingId: string; streamCallId: string; endedAt: Date };

/** One room segment's open device stays; rows written before segments were recorded (null call id) belong to every segment. */
const openSegmentStays = (args: SegmentEnd) => ({
  meetingId: args.meetingId,
  leftAt: null,
  OR: [{ streamCallId: args.streamCallId }, { streamCallId: null }],
});

/**
 * Closes the segment's open device stays that joined by its end stamp. The close is
 * an assumption (`closedByEnd`), so the outcome sweep asks Stream for the real leave.
 */
export function closeSegmentPresences(
  db: Pick<Tx, "meetingPresence">,
  args: SegmentEnd,
) {
  return db.meetingPresence.updateMany({
    where: { ...openSegmentStays(args), joinedAt: { lte: args.endedAt } },
    data: { leftAt: args.endedAt, closedByEnd: true },
  });
}

/** An open stay that joined after `endedAt`: a newer session of the segment owns the room. */
export function findStayAfterEnd(
  db: Pick<Tx, "meetingPresence">,
  args: SegmentEnd,
) {
  return db.meetingPresence.findFirst({
    where: { ...openSegmentStays(args), joinedAt: { gt: args.endedAt } },
    select: { id: true },
  });
}
