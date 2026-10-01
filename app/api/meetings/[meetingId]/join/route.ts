import { NextRequest, NextResponse } from "next/server";

import type { MemberRequest } from "@stream-io/node-sdk";

import prisma from "@/lib/prisma";
import { resolveSessionCallProfile } from "@/actions/stream/meetings/meeting.action";
import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import {
  buildAuthoritativeRoomPayload,
  buildMergingCallUpdate,
  CALL_MEMBER_ROLE,
} from "@/lib/meetings/room-payload";
import {
  getStreamVideoClient,
  StreamUnavailableError,
  isStreamQuotaError,
  STREAM_QUOTA_RETRY_AFTER_SECONDS,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { upsertUsersToStream } from "@/actions/stream/chat/user.action";
import { streamLogger } from "@/lib/stream-logger";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { reportSentryError } from "@/lib/observability/report";

/**
 * The claim this admission is for, read from the database and nowhere else.
 *
 * #C1 writes the `Meeting` row before the call is minted, so "a row with no
 * call" is the NORMAL state of a session whose first mint failed — and the room
 * has to be materialised later by whoever walks in first. That is why the
 * authoritative payload needs the row: it is the only thing that says which
 * occurrence this room belongs to, and therefore which booking's host, roster
 * and window the room has to be described with.
 *
 * Read by the row id the guard already resolved, NOT by parsing the URL — the
 * occurrence id survives a #1607 rebuild that moved `streamCallId`, and this
 * reads whichever room the row currently names.
 */
async function readClaimedRoom(meetingRowId: string) {
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingRowId },
    select: {
      streamCallId: true,
      occurrence: {
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          appointmentId: true,
          appointment: {
            select: { appointmentType: true, organizationId: true },
          },
        },
      },
    },
  });
  // A `Meeting` without its occurrence, or without the appointment behind it, is
  // corrupt data — and it is also the shape a broken fixture looks like. Either
  // way there is no authoritative payload to build, so the route degrades to the
  // minimal repair below rather than inventing one.
  if (!meeting?.occurrence?.appointment) return null;
  return meeting;
}

/**
 * The roster a join should hold, joiner last.
 *
 * `updateCallMembers` is idempotent (re-adding a member updates their role), so
 * this is a repair as much as a grant: a room minted before members were named,
 * or one created by a recovery that could not resolve the roster, gets it here.
 * The joiner goes LAST because a later entry for the same user wins, and their
 * `call_member` role must not be displaced by the roster's.
 */
function rosterWith(
  joinerId: string,
  roster: MemberRequest[],
): MemberRequest[] {
  const byUser = new Map<string, MemberRequest>();
  for (const member of [
    ...roster,
    { user_id: joinerId, role: CALL_MEMBER_ROLE },
  ]) {
    byUser.set(member.user_id, member);
  }
  return [...byUser.values()];
}

/**
 * POST /api/meetings/[meetingId]/join
 *
 * #1134 P0-1 — the join gate, and the only way to become a member of a call.
 *
 * Access control on video used to be a React conditional: the page rendered
 * "Access Denied" while the Stream token authorized every call in the app, so
 * `client.call(type, id).join()` from devtools walked into any consultation. Two
 * changes close it, and both are required:
 *
 *   1. `join-call` moves off the plain `user` role onto `call_member`
 *      (scripts/stream/ensure-call-type-grants.ts). Stream now refuses a
 *      non-member itself, whatever the UI does.
 *   2. This route is the sole grantor of membership, and it grants only after
 *      resolveMeetingAccess confirms the caller is on THIS appointment.
 *
 * Membership rather than a call-scoped token, deliberately: the video client is
 * an app-wide singleton holding one user token (that singleton is what fixed the
 * #248 remount storm), and the JS SDK has no per-call token on a shared client.
 * Minting a `call_cids` token would mean a second client per meeting. Granting
 * membership server-side gets the same property — Stream enforces the boundary,
 * and only an authorized server call can move it — without touching the
 * connection architecture. It is also what Stream's own "restrict access to a
 * call to a specific set of users" guidance describes.
 *
 * ## What this route does to the room, and why
 *
 * Three Stream steps, in this order, all of them AFTER the guard:
 *
 *   1. `getOrCreate` — materialise the room if the claim outlived its call. It
 *      carries the SAME authoritative payload the mint would have sent, resolved
 *      by `lib/meetings/room-payload.ts`, so a consultee who happens to arrive
 *      first does not become the room's author and does not leave the room
 *      without host metadata, a roster, a schedule or a duration bound. That was
 *      a P1: the recovery used to carry `created_by_id` and nothing else, so a
 *      failed first mint produced a permanently host-less, unbounded, unlisted
 *      room.
 *   2. a MERGING `update` — `getOrCreate` does not reconcile a call that already
 *      exists, and `update` REPLACES `custom` wholesale, so the room is read
 *      first and only the keys we own are laid over it. This is also where a
 *      stale duration cap heals: `lib/meetings/sync-call-window.ts` runs once
 *      per planner save, and when that save's Stream update fails the room keeps
 *      a cap for the OLD booking — a 60-minute session extended to four hours
 *      ended at ~105 minutes, mid-call, for everyone in it. The window read here
 *      comes from the committed occurrence row, so this is the calendar itself
 *      and never a guess.
 *   3. `updateCallMembers` — the actual grant.
 *
 * Every provider call is outside any database transaction (this route opens
 * none), and step 1 is preceded by a user sync because Stream rejects a request
 * naming a user it does not hold.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  // Hoisted for the catch: re-awaiting `params` there would rethrow if `params`
  // itself was what failed.
  let meetingIdForLog: string | undefined;
  try {
    const guard = await guardMeetingRoute(params, "admit to");
    if (!guard.ok) return guard.response;
    const { userId, meetingId, access } = guard;
    meetingIdForLog = meetingId;

    // #C8 — the call id comes from the RESOLVED row, not from the URL segment.
    // The end route has always read it that way (`toCallId(access.streamCallId)`)
    // and this one read the raw segment instead, which is two authorities for one
    // id: `default:`-prefixed URLs 404 here while working there, and after a
    // #1607 rebuild the segment and the row disagree, because the rebuild
    // rebinds `streamCallId` to `occurrence-<id>-r<suffix>` while the open tab is
    // still on `occurrence-<id>`. `toCallId` also normalises a cid to a bare id,
    // which is what `client.call(type, id)` expects — passing a cid through here
    // mints a call whose id literally contains a colon.
    //
    // The claimed room is PRESERVED, never re-minted from the occurrence: a
    // recovery has to land in the room the row already points at, or the row and
    // the call diverge and nothing reconciles them.
    const callId = toCallId(access.streamCallId);

    // Database only — no provider is touched until the guard above has answered.
    // `null` means there is no claim to read a payload from, which is the one
    // case the minimal repair below is the right answer for.
    //
    // Read by the ROW id the resolver returned, not the URL segment: the segment
    // is a call id, and #C9 lets it be an `occurrence-<id>` of any vintage or a
    // `default:`-prefixed cid. `access.meetingId` is the row itself, so this
    // works for all of them — and after a #1607 rebuild it names whichever room
    // the row points at NOW.
    const claimedRoom = await readClaimedRoom(access.meetingId);

    // The authoritative payload, resolved from the same rows and through the same
    // entitlement gate the mint uses, so recovery cannot describe a room
    // differently than normal provisioning would have. `null` when the booking
    // cannot be resolved: the window still applies, the identity does not, and
    // nothing is guessed on the caller's behalf.
    const identity = claimedRoom
      ? await resolveSessionCallProfile(claimedRoom.occurrence.id)
      : null;
    const payload = claimedRoom
      ? buildAuthoritativeRoomPayload({
          occurrenceId: claimedRoom.occurrence.id,
          appointmentId: claimedRoom.occurrence.appointmentId,
          appointmentType: claimedRoom.occurrence.appointment.appointmentType,
          organizationId: claimedRoom.occurrence.appointment.organizationId,
          startsAt: claimedRoom.occurrence.startsAt,
          // The committed row IS the calendar — the same source the planner edit
          // writes through — so the duration backstop is resolvable here even
          // when the identity profile could not be.
          windowEndsAt: claimedRoom.occurrence.endsAt,
          identity,
          fallbackAuthorId: userId,
        })
      : null;

    await withStreamCircuitBreaker(async () => {
      const call = getStreamVideoClient().video.call(STREAM_CALL_TYPE, callId);

      // A Meeting row does not guarantee the Stream call exists, and
      // updateCallMembers on a missing call throws — which this route reports as
      // a 500 after resolveMeetingAccess has already told the user they are
      // allowed in. Three ways a row outlives (or precedes) its call: the seeds
      // mint `Meeting` rows with faker ids and no Stream object at all;
      // `createDbMeeting` is a "use server" action whose id validator is
      // `z.string().min(1)`, so an entitled caller can write any string; and
      // maintenance drain ends the call while keeping the row.
      //
      // Creating here is NOT a P0-2 regression. P0-2 was the client minting a
      // billable call from an effect that raced the access check, so an
      // unauthorized visitor became `created_by` of a call that should not exist.
      // This runs only after resolveMeetingAccess has confirmed the caller is on
      // this appointment — authorization first, creation second, which is the
      // ordering P0-2 was about.
      //
      // #C1 — and it is no longer only a repair path for seeded rows. The mint
      // writes the `Meeting` row BEFORE it creates the call, so the normal state
      // of a session whose first mint failed is exactly this one: a row naming a
      // room that does not exist yet. Do not remove it on the grounds that
      // `provisionAppointmentMeeting` mints: that function short-circuits on an
      // existing row and deliberately does not re-mint, precisely so this route
      // can be the one that does.
      // #1270 — Stream refuses a call operation naming a user it does not hold,
      // and a token alone never creates one: only connectUser does. So the roster
      // is synced BEFORE anything names it, in both shapes below. Already-synced
      // ids are filtered inside.
      await upsertUsersToStream(payload ? payload.syncUserIds : [userId]);

      // #1270 — server-side auth carries no user context, so Stream requires an
      // explicit author on GetOrCreateCall; omitting it threw code 4 on EVERY
      // request. It is honoured only on actual creation, so an existing call
      // keeps its original author.
      //
      // With a claim, the payload carries the full description of the room — host
      // as author, host metadata, the roster, the schedule and the duration
      // backstop — so a consultee who happens to walk in first cannot end up
      // owning a host-less, unbounded room.
      await call.getOrCreate({
        data: payload ? payload.data : { created_by_id: userId },
      });

      // A call that ALREADY exists is not reconciled by `getOrCreate` — it returns
      // the room and ignores the payload — so the repair is an explicit read and a
      // MERGING update. Merging is not optional: Stream replaces `custom`
      // outright, so sending our keys alone would delete the host fields the
      // meeting UI reads, along with anything else the room legitimately holds.
      // Members cannot be lost here either — `UpdateCallRequest` carries no
      // `remove_members`.
      if (payload) {
        const { call: current } = await call.get();
        const request = buildMergingCallUpdate({
          currentCustom: current.custom,
          currentMaxDurationSeconds:
            current.settings?.limits?.max_duration_seconds,
          authoritative: payload.update,
        });
        if (request) {
          streamLogger.info("Reconciled a session room on join", {
            userId,
            meetingId,
            callId,
            maxDurationSeconds:
              request.settings_override?.limits?.max_duration_seconds,
          });
          await call.update(request);
        }
      }

      // ALWAYS `call_member`, for both sides. Verified against the live call type
      // rather than assumed: the `default` grants map has exactly six role keys —
      // guest, user, call_member, admin, global_read_only, global_admin. There is
      // no `host` key. An earlier draft assigned `"host"` to consultants and
      // `"user"` to everyone else, which would have locked out BOTH the moment
      // ensure-call-type-grants strips join-call from `user`: `host` has no grants
      // at all, and `user` would no longer have any either. That is a total video
      // outage disguised as a security fix.
      //
      // Nothing is lost. `call_member` is a strict superset of `user` on the live
      // type, and host-ness in the UI is derived from `custom.consultantUserId`
      // via useCallCustomData(), never from the Stream role.
      //
      // Idempotent: re-adding an existing member updates their role rather than
      // erroring, so a rejoin is a no-op, and an earlier roster entry is repaired
      // here. This is LAST on purpose — a failed repair above is not a successful
      // admission, so nobody is made a member of a room whose bound we could not
      // bring back in line with the booking.
      await call.updateCallMembers({
        update_members: rosterWith(userId, payload?.data.members ?? []),
      });
    });

    streamLogger.info("Admitted to meeting", {
      userId: userId,
      meetingId,
      callId,
      role: access.role,
    });

    // #C8 — the id handed back is the one the room actually has, not the one the
    // URL happened to carry. `useGetCallById` builds its `Call` handle from this
    // value, so returning the stale segment would have the client resolve a room
    // the server never granted membership on.
    return NextResponse.json({
      callType: STREAM_CALL_TYPE,
      callId,
      role: access.role,
    });
  } catch (error) {
    // Stream being down is not our bug and not the caller's fault. 503 says
    // "try again", which is true, and keeps a provider outage out of the 5xx
    // bucket that means "we broke something". The circuit breaker throws this
    // when it is open, so this is also the fast-fail path.
    if (error instanceof StreamUnavailableError) {
      streamLogger.warn("Meeting join unavailable — Stream circuit open", {
        meetingId: meetingIdForLog,
      });
      return NextResponse.json(
        { error: "Video is temporarily unavailable. Please try again." },
        { status: 503 },
      );
    }

    // #1829 — a Stream 429 is quota exhaustion, not a fault, and must not reach
    // Sentry or the 500.
    //
    // The breaker already classifies it correctly: `shouldTrip` excludes 429, and
    // `withStreamCircuitBreaker` deliberately skips capturing it ("already
    // alerted on by Stream itself"). The caller re-added it — every error that
    // was not `StreamUnavailableError` went to `reportSentryError` and out as a
    // 500, so a full per-minute budget on `GetOrCreateCall` or `JoinCall`
    // presented to the user as "something went wrong" AND spent Sentry quota
    // saying the same thing once per attempt. The system now trickles Stream
    // transients, which covers the volume; this covers the answer.
    if (isStreamQuotaError(error)) {
      return NextResponse.json(
        {
          error: "Video is busy right now. Please wait a moment and try again.",
          code: "STREAM_QUOTA",
        },
        {
          status: 503,
          headers: { "Retry-After": String(STREAM_QUOTA_RETRY_AFTER_SECONDS) },
        },
      );
    }

    // A failed room reconcile lands here too, and deliberately so: the room's
    // duration cap is the one thing that ends a paid session early with no
    // application involved, so admitting the caller into a room we could not
    // bring back in line with the booking would be the quiet version of exactly
    // the bug this step exists to heal.
    reportSentryError(error, {
      subsystem: "stream",
      op: "meetings.join",
    });
    streamLogger.error("Failed to admit to meeting", error);
    return NextResponse.json(
      { error: "Could not join this meeting. Please try again." },
      { status: 500 },
    );
  }
}
