/**
 * Ask Stream who was actually in a call.
 *
 * #1280 — the consultant no-show detector decides on the ABSENCE of a
 * `MeetingAttendance` row. Those rows are written by
 * `call.session_participant_joined` webhooks, and each party's row arrives in
 * its own delivery, potentially to a different Netlify instance. Lose only the
 * consultant's and the predicate "consultee has a row, consultant does not" is
 * satisfied exactly — the booking is CAS-cancelled and refunded in full against
 * a consultant who attended. It is idempotent, so it will not double-refund, but
 * reversing it means manually re-charging a customer.
 *
 * That this has not happened yet is luck: the webhook endpoint rejected every
 * delivery for months, so there are no attendance rows at all and the detector
 * has never had a candidate. It becomes live the moment attendance starts
 * working.
 *
 * Stream holds the same fact independently, and does not depend on our webhook
 * pipeline having worked. `report.participants.unique` is the count of distinct
 * participants in the session — so two, in a 1:1 consultation, means both
 * parties were there whatever our rows say.
 *
 * ## Which call type this asks about
 *
 * `streamCallId` on a `Meeting` is the BARE id, so it cannot say which of the
 * two call types the room is. Asking the wrong one is quiet and self-inflicted:
 * Stream 404s a call it does not hold, that surfaces as `null`, and `null` means
 * "no evidence" — so the no-show detector would refuse every webinar and class
 * candidate forever, with a refusal reason ("Stream has no report for …") that
 * names a call which plainly exists. The refusal is fail-safe, which is exactly
 * why it would have survived review: nobody is wrongly refunded, the feature is
 * just permanently off for half the product.
 *
 * So the type is resolved from the row rather than assumed, and the row is read
 * here rather than in each of the two callers because they cannot both be right:
 * `Meeting.streamCallId` is UNIQUE, so one indexed lookup answers it for a value
 * of unknown provenance, which is what a bare id is. A caller that already holds
 * the row passes `callType` and skips the read entirely.
 */
import {
  getStreamVideoClient,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import prisma from "@/lib/prisma";
import { normalizeCallType, toCallId } from "@/lib/stream/call-cid";
import { streamLogger } from "@/lib/stream-logger";

export interface CallPresenceEvidence {
  /** Distinct participants Stream saw in the session. */
  unique: number;
  /** Most participants present at the same moment, when Stream reports it. */
  maxConcurrent: number | null;
}

/**
 * The call type a bare `streamCallId` belongs to, read off the Meeting that
 * owns it. `null` when there is no such row, which means the same thing it
 * means everywhere else in this file: we cannot say.
 */
async function callTypeForStreamCallId(
  streamCallId: string,
): Promise<string | null> {
  const meeting = await prisma.meeting.findUnique({
    where: { streamCallId },
    select: { callType: true },
  });
  return meeting?.callType ?? null;
}

/**
 * What Stream says about attendance for a call, or `null` when it cannot say.
 *
 * `null` is NOT "nobody attended". It means Stream has no report — the call
 * never had a session, or the report has aged out (they expire at roughly six
 * months, while call *stats* are retained far longer). Callers deciding money
 * must treat `null` as "no evidence" and refuse to act, never as absence.
 *
 * @param callType `Meeting.callType`, when the caller already holds the row.
 * Omitting it costs one unique-indexed lookup and nothing else; supplying a
 * wrong one is the failure described in the header.
 */
export async function getCallPresenceEvidence(
  streamCallId: string,
  callType?: string | null,
): Promise<CallPresenceEvidence | null> {
  try {
    const client = getStreamVideoClient();
    // `normalizeCallType` because `callType` is a `String` column and an
    // unrecognised value must resolve against a call type this app really owns
    // rather than produce a CID on somebody else's.
    const type = normalizeCallType(
      callType ?? (await callTypeForStreamCallId(streamCallId)),
    );
    const call = client.video.call(type, toCallId(streamCallId));
    const response = await withStreamCircuitBreaker(() => call.getCallReport());
    const participants = response.report?.participants;
    if (!participants) return null;
    return {
      unique: participants.unique,
      maxConcurrent: participants.max_concurrent ?? null,
    };
  } catch (error) {
    // A missing report and a Stream outage are indistinguishable here, and both
    // mean the same thing to a caller about to move money: we do not know.
    streamLogger.warn("No Stream presence evidence for call", {
      streamCallId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
