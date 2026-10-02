/**
 * Broadcast control for a meeting that is on the `livestream` call type.
 *
 * Three verbs, and one reason they live together: go-live, end-live and read
 * the HLS playback URL are three answers to the same question — is this room a
 * broadcast, and who is allowed to say so? Split across three modules the
 * answers drift, and the drift is invisible because every layer of it reports
 * success.
 *
 * ## The call type is read from the row, never derived and never hardcoded
 *
 * A Stream call's type is IMMUTABLE — there is no migrate-call-type, so the
 * type a call was minted on is the only type that will ever answer for it.
 * Addressing it on the wrong type is the quietest failure in this subsystem:
 * Stream 404s, the route turns that into a user-facing error, and nothing pages.
 * So every function here resolves through `normalizeCallType(meeting.callType)`.
 *
 * `normalizeCallType` rather than a comparison, and not the CID: `Meeting.streamCallId`
 * stores the BARE id, which carries no type at all, so a CID read would answer
 * `default` for every row and quietly downgrade every webinar to a full-mesh
 * call. And normalising rather than comparing is what stops a hand-edited
 * `Meeting.callType` producing a CID on somebody else's call type (#1285).
 *
 * ## The `host` role is DESIGNATED here, and never self-assignable
 *
 * Stream's `livestream` type is wide open out of the box and there is no
 * "the presenter" concept on it — every attendee is a `call_member`. So
 * `goLive` writes the `host` role onto the caller's membership through
 * `updateCallMembers`, server-side, after the route has resolved that the
 * caller is on the hosting side of this booking. `endLive` reads that same
 * designation back and nothing else.
 *
 * That is the whole authorisation story for `endLive`, and it is deliberate
 * that it is not a value passed in. A `role` or `isHost` argument on `endLive`
 * would be a caller-supplied claim, and a caller-supplied claim is exactly what
 * #1270 was: the end-of-call control lived in a React conditional over call
 * data the browser had itself written, so two lines of devtools ended the
 * session for everyone. Whoever calls this must re-derive hostness from the
 * call, and the only authority that has it is Stream.
 *
 * The consequence, stated rather than hidden: a room that never went live has
 * no designated host, so `endLive` refuses it. Ending a session that never
 * started broadcasting is `POST /api/meetings/[id]/end`, which host-checks
 * through `resolveMeetingAccess` against the database instead. Two verbs, two
 * authorities, neither able to stand in for the other.
 *
 * ## The HLS playback URL is a BEARER CREDENTIAL
 *
 * `egress.hls.playlist_url` is not a link to a page — it is the key to the
 * stream. Anyone holding it can watch, with no token, no session and no
 * membership check, because HLS is served by a CDN and Stream cannot make a
 * per-viewer decision on a playlist URL. The consent that makes handing it out
 * safe lives entirely in `GET /api/meetings/[id]/livestream/stream-url`, which
 * runs the same `resolveMeetingAccess` gate as the join route and refuses
 * anyone who is not on the appointment.
 *
 * So: never logged (not even on the error path — see `resolveHlsUrl`), never
 * cached publicly, never returned to a non-participant, and never put in a
 * response that anything else shares. It is returned to exactly one audience,
 * from exactly one place.
 *
 * ## No Prisma transaction is open across any provider call below
 *
 * Every function here is provider-only apart from the org-admin lookup in
 * `endLive`, and that lookup completes before the Stream write. Holding a
 * database transaction open across a vendor HTTP call is how a Stream timeout
 * turns into a connection-pool exhaustion: the rows stay pinned for the full
 * duration of the provider's worst-case latency (the SDK defaults to 30s), and
 * on Netlify's single-connection pool one such call is an outage.
 */

import type { StreamCall } from "@stream-io/node-sdk";

import prisma from "@/lib/prisma";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import {
  getStreamVideoClient,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import {
  normalizeCallType,
  toCallId,
  type KnownCallType,
} from "@/lib/stream/call-cid";
import {
  hlsAvailableFor,
  isLivestreamMeeting,
  type LivestreamPlan,
} from "@/lib/stream/livestream-policy";
import { streamLogger } from "@/lib/stream-logger";

/**
 * The Stream call role this module designates on go-live.
 *
 * NOT `host` by convention and NOT borrowed from `CALL_MEMBER_ROLE` in
 * `lib/meetings/room-payload.ts`: those are the `default` call type's roles,
 * where `host` does not exist as a grant and stamping it locked both sides out
 * of the room (#1270). On `livestream` it is the opposite — the type ships a
 * `host` key, it is the natural name for the presenter, and `call_member` is
 * right for everyone else. Same word, different type, different grants; that is
 * why this constant is declared here rather than imported.
 *
 * Whether it currently CARRIES grants is a posture-script question and not this
 * module's to answer — `scripts/stream/ensure-call-type-grants.ts` owns it. This
 * module only writes the designation and reads it back.
 */
export const HOST_CALL_ROLE = "host";

/**
 * Why a verb refused, as a stable value.
 *
 * The route maps these to status codes, so it branches on `reason` and never on
 * `message` — the same rule `MeetingAccessReason` exists for. The split matters
 * most for `not_livestream`, which is NOT an authorisation failure: the caller
 * may well be the host, they simply asked to broadcast a consultation. That is
 * a 409, and answering 403 would tell a legitimate host they are not allowed to
 * do something they are in fact doing wrong.
 */
export type LivestreamRefusalReason =
  /** The meeting is not on the `livestream` call type. Not an auth failure. */
  | "not_livestream"
  /** No Stream call to act on yet — a row whose first mint has not happened. */
  | "no_call"
  /** The actor holds neither the designated `host` role nor an org grant. */
  | "not_host"
  /** The call is live but Stream reports no HLS egress to play. */
  | "hls_unavailable"
  /** Stream could not be asked. Distinct from "asked, and the answer was no". */
  | "stream_unreachable";

export interface LivestreamRefusal {
  ok: false;
  reason: LivestreamRefusalReason;
  /** User-facing. Never says which of several refusals applied, or why. */
  message: string;
}

export type LivestreamOutcome<T> = ({ ok: true } & T) | LivestreamRefusal;

/**
 * The Meeting fields these verbs read.
 *
 * Structural, like `SyncableSession` in `recording-service.ts`, so a
 * `Prisma.Meeting` and a hand-built object are both valid arguments. The narrow
 * field set is the point: everything the verbs need is here, and nothing in
 * this module can grow a dependency on a query it does not make.
 */
export interface LivestreamMeetingRef {
  id: string;
  /** BARE call id, per `Meeting.streamCallId`. `toCallId` normalises a cid. */
  streamCallId: string | null;
  callType: string | null;
  /** Denormalised tenant key — see the org-scope check on the row read below. */
  organizationId: string | null;
}

/**
 * The row a route reads before calling any verb, with the appointment's own
 * org id alongside it so the two can be compared in the same round trip.
 */
export interface LivestreamMeetingRow extends LivestreamMeetingRef {
  appointmentOrganizationId: string | null;
}

/**
 * Read the row a meeting route resolved, plus the org id it must agree with.
 *
 * `access.meetingId` is the row itself, so this works for every URL vintage —
 * a bare call id, a `livestream:`-prefixed cid, or an `occurrence-<id>` of any
 * age — and after a #1607 rebuild it names whichever room the row points at
 * NOW. See `resolveMeetingAccess`'s own header for why the URL segment is not
 * an authority on its own.
 *
 * ## The org comparison is the explicit scoping
 *
 * `Meeting.organizationId` is denormalised from `occurrence.appointment.organizationId`
 * at create time and never updated, which is exactly what makes it usable as a
 * scoping key AND exactly what makes it worth checking. A row whose stamp
 * disagrees with its appointment is a row this module cannot reason about: the
 * tenant we would authorise against is not the tenant the booking belongs to.
 * Rather than pick one and hope, the caller refuses — see
 * {@link assertSameOrganization}.
 *
 * @returns The row, or `null` when there is no such Meeting.
 */
export async function readLivestreamMeetingRow(
  meetingRowId: string,
): Promise<LivestreamMeetingRow | null> {
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingRowId },
    select: {
      id: true,
      streamCallId: true,
      callType: true,
      organizationId: true,
      occurrence: {
        select: { appointment: { select: { organizationId: true } } },
      },
    },
  });
  if (!meeting) return null;
  return {
    id: meeting.id,
    streamCallId: meeting.streamCallId,
    callType: meeting.callType,
    organizationId: meeting.organizationId,
    appointmentOrganizationId: meeting.occurrence.appointment.organizationId,
  };
}

/**
 * Refuse a row whose stamped org and owning appointment disagree.
 *
 * Not defensive theatre. Every org-scoped authorisation below reads
 * `meeting.organizationId` — the STAMP — so a row where that stamp is stale
 * would authorise a stranger against the wrong tenant, silently, with a 200 to
 * prove it. A 404 rather than a 403: from the caller's side this meeting does
 * not exist, and saying "your tenant key is wrong" would tell them the shape of
 * our schema for a row they have no other business knowing about.
 */
export function assertSameOrganization(
  row: LivestreamMeetingRow,
): LivestreamRefusal | null {
  if (row.organizationId === row.appointmentOrganizationId) return null;
  streamLogger.error("Meeting org stamp disagrees with its appointment", {
    meetingId: row.id,
  });
  return {
    ok: false,
    reason: "not_livestream",
    message: "Meeting not found",
  };
}

/**
 * The one refusal every verb shares: a room that is not a broadcast.
 *
 * Centralised because it is the check most likely to be forgotten, and the
 * consequence of forgetting it is the expensive one — `goLive` on a `default`
 * call is not refused by Stream (the SDK will happily POST go-live to any call
 * it holds), it just does nothing useful while telling us it worked, and the
 * presenter watches a stage that never reaches the audience.
 *
 * The message names neither the call type nor the plan: a participant who asks
 * for a stream URL on a consultation should not learn that consultations have a
 * different Stream call type.
 */
function refuseUnlessBroadcast(
  meeting: LivestreamMeetingRef,
): LivestreamRefusal | null {
  if (isLivestreamMeeting(meeting)) return null;
  return {
    ok: false,
    reason: "not_livestream",
    message: "This session cannot be broadcast.",
  };
}

/**
 * The call handle for a meeting, or the refusal that stops us making one.
 *
 * Addressed on the ROW's call type, always. `toCallId` rather than the raw
 * column because `Meeting.streamCallId` is stored bare but a copied URL or a
 * `livestream:`-prefixed value both arrive here, and passing a cid straight
 * into `client.call(type, id)` mints a call whose id literally contains a colon.
 */
function callHandleFor(
  meeting: LivestreamMeetingRef,
):
  | { ok: true; call: StreamCall; callType: KnownCallType; callId: string }
  | LivestreamRefusal {
  const refusal = refuseUnlessBroadcast(meeting);
  if (refusal) return refusal;
  if (!meeting.streamCallId) {
    return {
      ok: false,
      reason: "no_call",
      message: "This session's room is not ready yet.",
    };
  }
  const callType = normalizeCallType(meeting.callType);
  const callId = toCallId(meeting.streamCallId);
  return {
    ok: true,
    call: getStreamVideoClient().video.call(callType, callId),
    callType,
    callId,
  };
}

/**
 * Take a meeting live, and fan it out on HLS when the plan bought that.
 *
 * Two provider calls, in this order, and the order is the security property:
 *
 *   1. `updateCallMembers` — designate the caller as `host`. Before `goLive`,
 *      because a broadcast that starts without a presenter role has no owner at
 *      the vendor: `endLive` authorises on that designation, so going live
 *      first would leave a broadcast nobody can stop.
 *   2. `goLive` — leave backstage. Backstage is enabled by
 *      `scripts/stream/ensure-call-type-settings.ts` on this type precisely so
 *      this is a decision and not a side effect: without it, "production" would
 *      mint a room the audience can walk into while the hosts are still waiting
 *      in the green room.
 *
 * ## HLS is a separate decision, and it is fail-closed
 *
 * `start_hls` is asked only when `hlsAvailableFor` says BOTH the call type
 * qualifies AND the injected plan flag is explicitly true. A broadcast room on
 * a plan that never bought HLS still goes live — it is a real room with real
 * participants — it just does not fan out, because HLS is billed per viewer per
 * minute and "the caller asked" is not an entitlement.
 *
 * `plan` is optional and defaults to absent, which reads as NO. There is no
 * `livestreamEnabled` column on any of the four plan models, and inventing a
 * commercial tier enum here would fork the pricing vocabulary in a module whose
 * only job is a boolean (see `lib/stream/livestream-policy.ts` for that
 * argument in full). So the flag is injected and the default is off: the first
 * caller to have an answer passes it, and until then no code path can spend
 * HLS by accident.
 *
 * @returns `hls` reports what was ASKED for, not what Stream started. Stream
 * can refuse the egress and still answer go-live successfully, and claiming
 * otherwise here would put a "streaming now" in the UI over a call with no
 * playlist behind it.
 */
export async function goLive(args: {
  meeting: LivestreamMeetingRef;
  hostUserId: string;
  plan?: LivestreamPlan;
}): Promise<
  LivestreamOutcome<{ callType: KnownCallType; callId: string; hls: boolean }>
> {
  const handle = callHandleFor(args.meeting);
  if (!handle.ok) return handle;
  const { meeting, hostUserId } = args;

  const wantHls = hlsAvailableFor(meeting, args.plan);

  try {
    await withStreamCircuitBreaker(async () => {
      // The designation. Idempotent — re-designating an existing member updates
      // their role rather than erroring — so a re-go-live after a hiccup is a
      // no-op rather than a second host appearing.
      //
      // Server-side and unconditional, because the route has already decided
      // the caller is on the hosting side of THIS booking. Nothing the client
      // sent takes part in this decision; see the module header.
      await handle.call.updateCallMembers({
        update_members: [{ user_id: hostUserId, role: HOST_CALL_ROLE }],
      });

      await handle.call.goLive({ start_hls: wantHls });
    });
  } catch (error) {
    // The designation may or may not have landed before the go-live failed.
    // Deliberately NOT compensated: Stream refused, so the host role is a stale
    // label on a room that never went live, and `endLive` refusing that room is
    // the correct outcome anyway. Un-designating would be a second provider call
    // on a path that is already failing.
    streamLogger.error("Failed to take a meeting live", error, {
      meetingId: meeting.id,
      callType: handle.callType,
    });
    return {
      ok: false,
      reason: "stream_unreachable",
      message: "Could not start the broadcast. Please try again.",
    };
  }

  streamLogger.info("Meeting taken live", {
    meetingId: meeting.id,
    callType: handle.callType,
    hostUserId,
    hls: wantHls,
  });

  return {
    ok: true,
    callType: handle.callType,
    callId: handle.callId,
    hls: wantHls,
  };
}

/**
 * Does this user hold a role on this meeting's organisation that may close a
 * broadcast on its behalf?
 *
 * ACTIVE membership only — a SUSPENDED org operator has no more authority over
 * a live session than a suspended attendee has over the room, and the account
 * ban check in the route guard covers the platform side of the same rule.
 *
 * The grant is `appointments.actForOrg.cancel` and that is a judgement call
 * worth naming: there is no "end a livestream" key in `ORG_PERMISSIONS`, and
 * adding one means editing `lib/auth/org-permissions.ts`, which a jest pin
 * governs and which is not this file's to change. Of the existing keys, that
 * one is the same act — stopping a session for everyone, on the org's behalf —
 * at the same tier (GOVERNANCE: OWNER, MAINTAINER). Reusing it means an org
 * operator's authority over live sessions cannot drift from their authority over
 * cancelling the sessions underneath, which is the coupling that actually
 * matters.
 */
async function isOrgAdminOf(
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId } },
    select: { status: true, role: true },
  });
  return (
    membership?.status === "ACTIVE" &&
    hasOrgPermission(membership.role, "appointments.actForOrg.cancel")
  );
}

/**
 * Is this user the host this meeting designated at go-live?
 *
 * Read back from Stream rather than taken as an argument — see the module
 * header for why an `isHost` parameter would reintroduce #1270.
 *
 * The filter is applied VENDOR-side and names the role as well as the user, so
 * one page is the whole answer. Walking members client-side would be wrong at
 * exactly the wrong moment: `queryMembers` pages at 20 by default and a webinar
 * is routinely larger than that, so a host who had scrolled past the first page
 * would be told they were not the host and unable to stop their own broadcast.
 */
async function isDesignatedHost(
  call: StreamCall,
  userId: string,
): Promise<boolean> {
  const { members } = await withStreamCircuitBreaker(() =>
    call.queryMembers({
      limit: 1,
      filter_conditions: { user_id: { $eq: userId }, role: HOST_CALL_ROLE },
    }),
  );
  return members.length > 0;
}

/**
 * Stop the broadcast.
 *
 * `stopLive`, not `end`. Three reasons, and the first is the one that matters:
 *
 *   - `end` is irreversible at the vendor. A call's `ended_at` never clears, so
 *     the SDK renders "ended" forever even after a new session opens — the trap
 *     #1607 exists for, which is why `provisionAppointmentMeeting` mints a whole
 *     NEW call id to rebuild a room. A host who mis-clicks would burn the room.
 *   - `end` is already owned by `POST /api/meetings/[id]/end`, host-checked
 *     through the database. Duplicating it here would be a second, weaker
 *     version of the same control.
 *   - `stopLive` is the exact inverse of `goLive`: it returns the call to
 *     backstage and, with no `continue_*` flags, stops the HLS egress too — so
 *     the playlist a participant may already hold stops resolving.
 *
 * Authorisation is the designated `host`, or an ACTIVE org operator on the
 * meeting's stamped org. Nothing else, and nothing the caller supplied.
 */
export async function endLive(args: {
  meeting: LivestreamMeetingRef;
  actorUserId: string;
}): Promise<LivestreamOutcome<{ callType: KnownCallType; callId: string }>> {
  const handle = callHandleFor(args.meeting);
  if (!handle.ok) return handle;
  const { meeting, actorUserId } = args;

  let authorised = false;
  try {
    authorised = await isDesignatedHost(handle.call, actorUserId);
  } catch {
    streamLogger.warn("Could not read the host designation for a broadcast", {
      meetingId: meeting.id,
    });
    return {
      ok: false,
      reason: "stream_unreachable",
      message: "Could not verify who is hosting. Please try again.",
    };
  }

  // The org branch runs only after the host branch said no, so a designated host
  // costs one provider call and never touches the database.
  if (!authorised && meeting.organizationId) {
    try {
      authorised = await isOrgAdminOf(actorUserId, meeting.organizationId);
    } catch (error) {
      streamLogger.error("Could not read the actor's org membership", error, {
        meetingId: meeting.id,
      });
      return {
        ok: false,
        reason: "stream_unreachable",
        message: "Could not verify who is hosting. Please try again.",
      };
    }
  }

  if (!authorised) {
    streamLogger.warn("Livestream end refused — caller is not the host", {
      userId: actorUserId,
      meetingId: meeting.id,
    });
    return {
      ok: false,
      reason: "not_host",
      message: "Only the host can end this broadcast.",
    };
  }

  try {
    await withStreamCircuitBreaker(() => handle.call.stopLive());
  } catch (error) {
    streamLogger.error("Failed to stop the broadcast", error, {
      meetingId: meeting.id,
      callType: handle.callType,
    });
    return {
      ok: false,
      reason: "stream_unreachable",
      message: "Could not end the broadcast. Please try again.",
    };
  }

  streamLogger.info("Livestream ended", {
    userId: actorUserId,
    meetingId: meeting.id,
  });

  return { ok: true, callType: handle.callType, callId: handle.callId };
}

/**
 * The signed HLS playback URL for a live broadcast, or `null` when there is
 * none.
 *
 * ## Nothing in this function logs the URL
 *
 * Not on the happy path, and — less obviously — not on the error path either.
 * `streamLogger.error` is the natural thing to reach for and it takes the
 * error's message, and a vendor error is exactly the sort of payload that can
 * echo back the request that produced it. A bearer credential in the log sink
 * is readable by anyone with log access, persists after the broadcast ends, and
 * is never rotated. So the only thing that leaves here is whether a playlist
 * was found, and the error is logged without its message.
 *
 * The caller's half of the contract is equally load-bearing: the URL goes back
 * in a `Cache-Control: no-store` response to a caller
 * `resolveMeetingAccess` has already confirmed is on the appointment, and to
 * nobody else. There is no CDN or shared cache in front of that header by
 * accident — it is set on the route.
 *
 * No plan gate here, deliberately. `hlsAvailableFor` decides whether we SPEND
 * HLS by starting the egress; whether a participant may PLAY an egress that
 * already exists is a different question, and the answer is whoever is on the
 * booking — which is the question the route asks. Gating the read on a flag the
 * read path has no way to resolve would only ever produce a "no stream" to
 * someone who is entitled to the stream.
 *
 * @returns The URL, or `null` when Stream reports no HLS egress on the call.
 */
export async function resolveHlsUrl(args: {
  meeting: LivestreamMeetingRef;
}): Promise<
  LivestreamOutcome<{ playlistUrl: string; hlsStatus: string | null }>
> {
  const handle = callHandleFor(args.meeting);
  if (!handle.ok) return handle;
  const { meeting } = args;

  let playlistUrl: string | null = null;
  let hlsStatus: string | null = null;
  try {
    const { call } = await withStreamCircuitBreaker(() => handle.call.get());
    const hls = call.egress?.hls;
    playlistUrl = hls?.playlist_url ?? null;
    hlsStatus = hls?.status ?? null;
  } catch (error) {
    // See the header: the error message is withheld on purpose. The presence
    // flag is the diagnostic, and it cannot carry a credential.
    streamLogger.warn("Could not read the HLS egress for a broadcast", {
      meetingId: meeting.id,
      callType: handle.callType,
      reachable: false,
      error: error instanceof Error ? error.name : "non-error",
    });
    return {
      ok: false,
      reason: "stream_unreachable",
      message: "Could not reach the stream right now. Please try again.",
    };
  }

  if (!playlistUrl) {
    streamLogger.info("No HLS egress on a broadcast call", {
      meetingId: meeting.id,
      hlsStatus,
    });
    return {
      ok: false,
      reason: "hls_unavailable",
      message: "This broadcast is not available to stream.",
    };
  }

  // The one place the URL exists outside the vendor and the response body.
  streamLogger.info("Issued an HLS playback URL", {
    meetingId: meeting.id,
    hlsStatus,
  });

  return { ok: true, playlistUrl, hlsStatus };
}
