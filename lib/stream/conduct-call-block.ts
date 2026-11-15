import prisma from "@/lib/prisma";
import {
  getStreamVideoClient,
  isExpectedStreamError,
} from "@/lib/stream-client";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { conductRemovalStands } from "@/lib/support/conduct-removal-state";

/** Rooms read per page while a drive walks the appointment's open rooms. */
const ROOM_PAGE_SIZE = 50;

type VideoCall = ReturnType<
  ReturnType<typeof getStreamVideoClient>["video"]["call"]
>;

class BlockBudgetSpent extends Error {}

/** Stops waiting at the deadline; a call that lands later runs `onLate`, since Stream still applies it. */
function beforeDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
  onLate: () => void,
): Promise<T> {
  const remainingMs = deadlineMs - Date.now();
  let timedOut = false;
  void work.then(
    () => timedOut && onLate(),
    () => undefined,
  );
  if (remainingMs <= 0) {
    timedOut = true;
    return Promise.reject(new BlockBudgetSpent());
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new BlockBudgetSpent());
    }, remainingMs);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

/** Kicks the user and blocks them from rejoining; a user not in the call is blocked alone. */
async function blockInRoom(
  call: VideoCall,
  userId: string,
  deadlineMs: number,
  onLate: () => void,
): Promise<void> {
  try {
    await beforeDeadline(
      call.kickUser({ user_id: userId, block: true }),
      deadlineMs,
      onLate,
    );
  } catch (error) {
    if (!isExpectedStreamError(error)) throw error;
    await beforeDeadline(
      call.blockUser({ user_id: userId }),
      deadlineMs,
      onLate,
    );
  }
}

async function unblockInRoom(
  call: VideoCall,
  userId: string,
  deadlineMs: number,
  onLate: () => void,
): Promise<void> {
  try {
    await beforeDeadline(
      call.unblockUser({ user_id: userId }),
      deadlineMs,
      onLate,
    );
  } catch (error) {
    if (!isExpectedStreamError(error)) throw error;
  }
}

type BlockCursor = { id: string; resumeAfter: string | null; updatedAt: Date };

function openIntent(
  appointmentId: string,
  userId: string,
): Promise<BlockCursor | null> {
  return prisma.streamRevocationRetry.findFirst({
    where: {
      erasureRequestId: null,
      kind: "CONDUCT_CALL_BLOCK",
      planId: appointmentId,
      userId,
      status: { not: "SUCCEEDED" },
    },
    select: { id: true, resumeAfter: true, updatedAt: true },
  });
}

/** Keeps the last room this generation finished; a re-arm since then clears it instead. */
async function saveProgress(
  cursor: BlockCursor | null,
  resumeAfter: string | null,
): Promise<void> {
  if (!cursor || !resumeAfter || resumeAfter === cursor.resumeAfter) return;
  await prisma.streamRevocationRetry
    .updateMany({
      where: { id: cursor.id, updatedAt: cursor.updatedAt },
      data: { resumeAfter },
    })
    .catch(() => undefined);
}

function roomPage(appointmentId: string, after: string | null) {
  return prisma.meeting.findMany({
    where: { occurrence: { appointmentId }, endedAt: null },
    select: { id: true, streamCallId: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: ROOM_PAGE_SIZE,
    ...(after ? { cursor: { id: after }, skip: 1 } : {}),
  });
}

/**
 * Brings every open room in line with the removal as Postgres reads it, then re-checks:
 * a write gone stale meanwhile, or landing after its budget, re-arms the intent.
 */
export async function driveConductCallBlock(
  appointmentId: string,
  userId: string,
  deadlineMs: number,
  rearm: () => Promise<void>,
): Promise<string | null> {
  let block: boolean;
  let cursor: BlockCursor | null;
  try {
    [block, cursor] = await Promise.all([
      conductRemovalStands(appointmentId, userId),
      openIntent(appointmentId, userId),
    ]);
  } catch {
    return "conduct block lookup failed";
  }
  const repairIfStale = async () => {
    if ((await conductRemovalStands(appointmentId, userId)) !== block) {
      await rearm();
      return true;
    }
    return false;
  };
  const onLate = () => {
    repairIfStale().catch(() => undefined);
  };
  const video = getStreamVideoClient().video;
  let done = cursor?.resumeAfter ?? null;
  for (;;) {
    let page: { id: string; streamCallId: string }[];
    try {
      page = await roomPage(appointmentId, done);
    } catch {
      await saveProgress(cursor, done);
      return "conduct block room lookup failed";
    }
    // Sequential on purpose: a revocation's Stream writes stay one at a time.
    for (const room of page) {
      const call = video.call(STREAM_CALL_TYPE, toCallId(room.streamCallId));
      try {
        if (Date.now() >= deadlineMs) throw new BlockBudgetSpent();
        await (block
          ? blockInRoom(call, userId, deadlineMs, onLate)
          : unblockInRoom(call, userId, deadlineMs, onLate));
      } catch (error) {
        await saveProgress(cursor, done);
        if (error instanceof BlockBudgetSpent) {
          return "time budget spent before the conduct block";
        }
        return block ? "call block failed" : "call unblock failed";
      }
      done = room.id;
    }
    if (page.length < ROOM_PAGE_SIZE) break;
  }
  try {
    if (await repairIfStale()) return "the removal changed during the drive";
  } catch {
    return "conduct block re-check failed";
  }
  return null;
}
