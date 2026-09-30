/**
 * Re-stamp a session's Stream call after the booking behind it moved.
 *
 * #C7 — a planner time edit (`replaceOccurrence`) rewrites `startsAt`/`endsAt`
 * on the `AppointmentOccurrence` row IN PLACE, because `Meeting` and `Recording`
 * cascade on occurrence delete and a duration-only edit must not cost a host
 * their recordings. Keeping the row is the right call, and it is also the whole
 * problem: the row is not the only description of the session. The Stream call
 * carries its own copy of the window —
 *
 *   - `custom.sessionStartsAt` / `custom.sessionEndsAt` / `sessionDurationMinutes`,
 *     which the meeting screens render (app/meetings/[id]/session-info.ts); and
 *   - `settings_override.limits.max_duration_seconds`, the SFU's own hard stop
 *     (lib/meetings/duration-cap.ts), which counts from FIRST JOIN.
 *
 * and neither was told. A 60-minute consultation extended to four hours kept a
 * cap of roughly 105 minutes, so Stream terminated the call 135 minutes before
 * its booked end, mid-session, for everyone in it. Nothing in the app could see
 * that coming: the row said four hours, the SFU said 105 minutes, and the two
 * only met when the room died.
 *
 * ## Why this is a module and not a call inside `replaceOccurrence`
 *
 * `replaceOccurrence` receives a `PrismaLike` — an ALREADY-OPEN interactive
 * transaction from `crud-with-plan`. Awaiting a provider call inside one holds a
 * database transaction, a connection and a row lock for the length of a network
 * round trip, and this route's transaction is `Serializable` with a 10 s budget
 * and a retry wrapper. That is the rule the whole repo follows; this is where it
 * is most tempting to break, because the function that knows the times moved is
 * the one that cannot safely tell Stream.
 *
 * So the write order is: `replaceOccurrence` RETURNS what moved (it already
 * computes `moved` for `movedAt`), the transaction commits, and the caller runs
 * this. Not an injected callback either — a callback invoked from inside
 * `replaceOccurrence` would run inside that same transaction, which is the thing
 * being avoided. The return value is the seam: the scheduling module stays free
 * of Stream, so it stays testable without a provider and free of an import cycle
 * with the join gate, and the provider call is a line the caller can see.
 *
 * ## Read-merge-write, and why not a partial update
 *
 * Stream REPLACES the whole `custom` object on update; it does not merge. Sending
 * only the two timestamps would therefore delete every other key — including
 * `consultantUserId` and `hostUserIds`, which are what the meeting UI derives
 * "End for everyone" from, and `organizationId`, which the org audit reads. The
 * alternative, rebuilding the blob from `resolveSessionCallProfile`, needs the
 * caller's session (that resolver is entitlement-gated) and would overwrite
 * whatever the room legitimately holds. So: read the call, change exactly the
 * three keys the planner moved, write it back. The read is one extra round trip
 * on a path that runs once per planner save.
 *
 * ## Failure is logged, never thrown
 *
 * The row is already committed by the time this runs, and the row is the
 * calendar. A planner who has just saved a time must not get a 500 because
 * Stream was briefly unreachable — and a thrown error here could not undo the
 * save anyway, so all it would achieve is a lie about whether the save worked.
 * What it does instead is leave the call's own cap stale, so the failure is
 * logged at `error` and picked up by the next join (the mint re-sends
 * `max_duration_seconds`) or the next planner save.
 */
import prisma from "@/lib/prisma";
import { resolveMaxCallDurationSeconds } from "@/lib/meetings/duration-cap";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { streamLogger } from "@/lib/stream-logger";
import {
  getStreamVideoClient,
  isStreamConfigured,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";

export type CallWindowSyncResult =
  /** The call was updated. */
  | { updated: true }
  /** No `Meeting` row for this occurrence — the room has never been minted. */
  | { updated: false; reason: "no_meeting" }
  /** Stream is not configured, or the call itself is gone. */
  | { updated: false; reason: "no_call" }
  /** Stream answered with nothing usable to merge onto. */
  | { updated: false; reason: "unreadable" }
  /** Stream refused or was unreachable. The row is committed either way. */
  | { updated: false; reason: "stream_error" };

/**
 * Tell the session's Stream call where its booking now runs.
 *
 * @param occurrence The occurrence whose row has ALREADY been updated, with its
 *   committed `id`, `startsAt` and `endsAt`. The id selects the `Meeting` row
 *   through `appointmentOccurrenceId` (@unique), never through `streamCallId` —
 *   the call id is the thing that can be stale here, and after a #1607 rebuild it
 *   is.
 */
export async function syncCallWindowForOccurrence(occurrence: {
  id: string;
  startsAt: Date;
  endsAt: Date;
}): Promise<CallWindowSyncResult> {
  const meeting = await prisma.meeting.findUnique({
    where: { appointmentOccurrenceId: occurrence.id },
    select: { id: true, streamCallId: true },
  });
  if (!meeting) {
    // The room is minted lazily, on the first join. A booking that has never been
    // entered has nothing to correct — the mint reads these same times.
    return { updated: false, reason: "no_meeting" };
  }

  if (!isStreamConfigured()) {
    streamLogger.error(
      "Stream not configured — the call keeps its stale session window",
      { meetingId: meeting.id, streamCallId: meeting.streamCallId },
    );
    return { updated: false, reason: "no_call" };
  }

  const call = getStreamVideoClient().video.call(
    STREAM_CALL_TYPE,
    toCallId(meeting.streamCallId),
  );

  // The run is not in doubt here: the planner has just written it. That is worth
  // saying because `resolveMaxCallDurationSeconds` returns null for a run it
  // could not RESOLVE, and its docstring is emphatic that a guessed cap is worse
  // than no cap because the SFU would end a long session early. Here the value is
  // read from the row the caller just committed, not inferred — so passing it is
  // the resolved case, and a null would mean a caller wired this up wrong.
  const maxDurationSeconds = resolveMaxCallDurationSeconds(
    { endsAt: occurrence.endsAt },
    occurrence.startsAt,
  );
  if (maxDurationSeconds === null) {
    // Unreachable for a well-formed window; treated as a refusal rather than a
    // guessed number, per that function's own doctrine.
    return { updated: false, reason: "unreadable" };
  }

  const durationMinutes = Math.max(
    Math.round(
      (occurrence.endsAt.getTime() - occurrence.startsAt.getTime()) / 60000,
    ),
    0,
  );

  try {
    const { call: current } = await withStreamCircuitBreaker(() => call.get());

    const merged = {
      ...(current.custom ?? {}),
      sessionStartsAt: occurrence.startsAt.toISOString(),
      sessionEndsAt: occurrence.endsAt.toISOString(),
      sessionDurationMinutes: durationMinutes,
    };

    await withStreamCircuitBreaker(() =>
      // NOTE the flat body: `update` takes `UpdateCallRequest` directly, unlike
      // `getOrCreate`, which wraps its payload in `{ data: … }`. Copying the
      // mint's shape here fails to compile, which is the only reason it is worth
      // spelling out.
      call.update({
        custom: merged,
        settings_override: {
          limits: { max_duration_seconds: maxDurationSeconds },
        },
      }),
    );

    streamLogger.info("Session window re-stamped on the Stream call", {
      meetingId: meeting.id,
      streamCallId: meeting.streamCallId,
      startsAt: occurrence.startsAt.toISOString(),
      endsAt: occurrence.endsAt.toISOString(),
      maxDurationSeconds,
    });
    return { updated: true };
  } catch (error) {
    // The window is now wrong ON STREAM while being right in the database. Log
    // it loudly — this is the one failure mode where the app is right and the
    // provider is not, and the consequence (an SFU cut short of the booked end)
    // lands on a paid consultation.
    streamLogger.error(
      "Could not re-stamp the session window on the Stream call",
      error,
      { meetingId: meeting.id, streamCallId: meeting.streamCallId },
    );
    return { updated: false, reason: "stream_error" };
  }
}
