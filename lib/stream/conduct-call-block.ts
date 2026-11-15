import prisma from "@/lib/prisma";
import {
  getStreamVideoClient,
  isExpectedStreamError,
} from "@/lib/stream-client";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { conductRemovalStands } from "@/lib/support/conduct-removal-state";

/** Rooms read for one block drive; an appointment provisions one room per session. */
const ROOM_CAP = 50;

type VideoCall = ReturnType<
  ReturnType<typeof getStreamVideoClient>["video"]["call"]
>;

class BlockBudgetSpent extends Error {}

function beforeDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<T> {
  work.catch(() => undefined);
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) return Promise.reject(new BlockBudgetSpent());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BlockBudgetSpent()), remainingMs);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

/** Kicks the user and blocks them from rejoining; a user not in the call is blocked alone. */
async function blockInRoom(
  call: VideoCall,
  userId: string,
  deadlineMs: number,
): Promise<void> {
  try {
    await beforeDeadline(
      call.kickUser({ user_id: userId, block: true }),
      deadlineMs,
    );
  } catch (error) {
    if (!isExpectedStreamError(error)) throw error;
    await beforeDeadline(call.blockUser({ user_id: userId }), deadlineMs);
  }
}

async function unblockInRoom(
  call: VideoCall,
  userId: string,
  deadlineMs: number,
): Promise<void> {
  try {
    await beforeDeadline(call.unblockUser({ user_id: userId }), deadlineMs);
  } catch (error) {
    if (!isExpectedStreamError(error)) throw error;
  }
}

/**
 * Makes the appointment's open rooms match the user's conduct removal, read
 * from Postgres first: blocked while it stands, unblocked once overturned.
 * Returns the error to record, or null when every open room matches.
 */
export async function driveConductCallBlock(
  appointmentId: string,
  userId: string,
  deadlineMs: number,
): Promise<string | null> {
  let block: boolean;
  let rooms: { streamCallId: string }[];
  try {
    [block, rooms] = await Promise.all([
      conductRemovalStands(appointmentId, userId),
      prisma.meeting.findMany({
        where: { occurrence: { appointmentId }, endedAt: null },
        select: { streamCallId: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: ROOM_CAP,
      }),
    ]);
  } catch {
    return "conduct block lookup failed";
  }
  const video = getStreamVideoClient().video;
  // Sequential on purpose: a revocation's Stream writes stay one at a time.
  for (const room of rooms) {
    const call = video.call(STREAM_CALL_TYPE, toCallId(room.streamCallId));
    try {
      await (block
        ? blockInRoom(call, userId, deadlineMs)
        : unblockInRoom(call, userId, deadlineMs));
    } catch (error) {
      if (error instanceof BlockBudgetSpent) {
        return "time budget spent before the conduct block";
      }
      return block ? "call block failed" : "call unblock failed";
    }
  }
  return null;
}
