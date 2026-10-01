/**
 * What a session's Stream call is described with — ONE resolution, two shapes.
 *
 * ## Why this module exists
 *
 * #C1 writes the `Meeting` row BEFORE the call is minted, which is what makes an
 * orphaned provider room impossible: every reconciler in the product finds work
 * by SCANNING `prisma.meeting`, so a call with no row is invisible to all of
 * them, forever. The cost of that ordering is that the row can outlive its call,
 * and the room has to be materialised later by someone who is not the mint.
 *
 * That "someone" is `POST /api/meetings/[meetingId]/join`, and it used to
 * recover with `getOrCreate({ data: { created_by_id: userId } })` — the caller's
 * own id and nothing else. So whenever provisioning's first mint failed after
 * the row committed, the room that eventually appeared was built by WHOSEVER
 * walked in first, which for half of all sessions is the consultee:
 *
 *   - Stream's own record of who owns the room named the wrong person;
 *   - `custom` carried no `consultantUserId` / `hostUserIds`, and those are
 *     what `useSessionInfo()` derives host-ness — and therefore "End for
 *     everyone" — from, so nobody in the room was a host to the UI;
 *   - `starts_at` and the `max_duration_seconds` backstop were absent, so the
 *     SFU had no bound on a billable room at all.
 *
 * The cure is not a second, better payload. It is ONE payload, resolved once and
 * used by both entry points: the mint (`provisionAppointmentMeeting`) and the
 * recovery (the join route). They must not be able to drift, because the room
 * they disagree about is the same room and only one of them wrote it.
 *
 * ## The two shapes, and why a merge exists at all
 *
 * `GetOrCreateCallRequest` wraps its payload as `{ data: CallRequest }` and
 * `UpdateCallRequest` does not (`@stream-io/node-sdk`'s `gen/models`, lines
 * 9437 and 18427) — a real trap, and the reason this module hands back both
 * shapes side by side instead of making each call site assemble its own.
 *
 * `getOrCreate` only applies `data` when it CREATES the call. For a room that
 * already exists it is a no-op beyond returning it, so recovery cannot rely on
 * it alone to repair a room that is missing attributes. And `update` REPLACES
 * the whole `custom` object rather than merging it, so the repair has to read
 * the call, merge, and write back — which is what
 * {@link buildMergingCallUpdate} is for, and why `update` is deliberately never
 * sent raw.
 *
 * ## Pure on purpose
 *
 * No database, no provider, no session. Identity arrives as a
 * {@link RoomIdentityProfile} the caller has already resolved (and already
 * entitlement-gated), and the window arrives as two dates. That keeps the policy
 * — who authors the room, what it says about itself, how long the SFU may run —
 * testable without a provider, and it is why this module can sit under a
 * `"use server"` action AND a route handler without either importing the other.
 */
import type { CallRequest, UpdateCallRequest } from "@stream-io/node-sdk";
import type { AppointmentsType } from "@prisma/client";

import { resolveMaxCallDurationSeconds } from "@/lib/meetings/duration-cap";

/**
 * The one role every member of an appointment call is named with (#1270).
 *
 * It used to be `host` for the consultant and `user` for everyone else, which
 * was worse than useless: the live `default` call type has exactly six role
 * keys — guest, user, call_member, admin, global_read_only, global_admin — and
 * no `host` among them, so a consultant stamped `host` held no grants at all.
 * The moment scripts/stream/ensure-call-type-grants.ts strips `join-call` from
 * `user`, that pair locks BOTH sides out: one role does not exist and the other
 * no longer admits anyone.
 *
 * `call_member` is what POST /api/meetings/[meetingId]/join assigns, and it is
 * the role the grants script keeps `join-call` on.
 *
 * Moved here from `meeting.action.ts` rather than duplicated: the join route
 * needs the same role the mint names members with, and two constants that mean
 * the same thing is the exact failure the grants script would turn into a total
 * video outage.
 */
export const CALL_MEMBER_ROLE = "call_member";

/**
 * A call member as the SDK takes it. Structurally `SessionCallMember` from the
 * mint, declared here so this module does not depend on a `"use server"` file
 * (which would be a cycle: that file imports the builder this module exports).
 */
export interface RoomMember {
  user_id: string;
  role: string;
}

/**
 * Everything about a session that a Stream call should describe itself with,
 * resolved from the appointment by the caller.
 *
 * `null` is a real answer, not a failure: it means the caller could not resolve
 * the booking (a database blip, or the consent refusal that
 * `resolveSessionCallProfile` degrades to). Nothing below invents a value in its
 * place — a payload that names the wrong host is worse than one that names none,
 * because host-ness is read back out of it.
 */
export interface RoomIdentityProfile {
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
  offeringTitle: string | null;
  members: RoomMember[];
  hostUserIds: string[];
  /** Owner plus ACCEPTED co-presenter — who may end the call for everyone. */
  hostControlUserIds: string[];
  guestUserIds: string[];
  hostName: string | null;
  guestName: string | null;
}

/**
 * The resolved payload, in both shapes the SDK wants.
 *
 * `syncUserIds` is a third output because Stream REJECTS the whole request when
 * a call names a user it does not hold ("Please create users before referencing
 * them in a call") and never auto-creates one from a reference. 29% of
 * consultants were missing once because only the chat paths upsert (#1270). The
 * ids therefore have to be synced BEFORE `data` is sent, which is an ordering
 * requirement on the call site rather than something this module can enforce.
 */
export interface AuthoritativeRoomPayload {
  /** Exactly what a `GetOrCreateCall` must carry. */
  data: CallRequest;
  /**
   * Exactly the keys WE own, as an `UpdateCallRequest`. Never send this raw:
   * Stream replaces `custom` wholesale, so it must be merged onto the call's
   * current blob with {@link buildMergingCallUpdate}.
   */
  update: UpdateCallRequest;
  /** Ids Stream must hold before `data` names them. */
  syncUserIds: string[];
}

/**
 * The occurrence's own bounds, resolved server-side.
 *
 * @param identity Null when the booking could not be resolved. The room is then
 *   described by the window alone, never by a guessed host.
 * @param windowEndsAt The run's end. Null leaves the duration backstop OFF
 *   entirely rather than guessing it — see `resolveMaxCallDurationSeconds`,
 *   whose own doctrine is that a guessed cap ends a long session early. The
 *   mint passes `null` whenever its call profile was unresolved; recovery
 *   passes the committed occurrence row's end, which is the calendar itself and
 *   therefore never a guess.
 * @param fallbackAuthorId Stream requires SOME author on a create
 *   (`GetOrCreateCall` is refused outright without one, #1270). Server-side auth
 *   carries no user context, so a session whose host cannot be resolved falls
 *   back to the caller rather than failing to mint.
 */
export function buildAuthoritativeRoomPayload(args: {
  occurrenceId: string;
  appointmentId: string | null | undefined;
  appointmentType: AppointmentsType;
  organizationId: string | null | undefined;
  startsAt: Date;
  windowEndsAt: Date | null;
  identity: RoomIdentityProfile | null;
  fallbackAuthorId: string;
}): AuthoritativeRoomPayload {
  const { identity } = args;

  // The consultant owns the room, whoever opened the door.
  const authorUserId = identity?.hostUserIds[0] ?? args.fallbackAuthorId;

  // #1280 — a server-side duration cap, as a BILLING and data-integrity
  // backstop. Free: `limits.max_duration_seconds` is a call-type/per-call
  // setting, not a metered service. #1160's correction is the whole design: the
  // timer counts from the moment the FIRST PARTICIPANT JOINS, not from
  // `starts_at`, so it is set generously — see `lib/meetings/duration-cap.ts`.
  //
  // What it buys, which nothing else in the stack provides:
  //   1. Stream stamps `ended_at` whether or not our webhook pipeline works —
  //      #1134 found 1,417 sessions with no `endedAt` and a pipeline that had
  //      never processed one event.
  //   2. It bounds the worst-case bill. A forgotten tab or a client that fails
  //      to tear down media bills participant minutes indefinitely, and the only
  //      thing standing between us and an unbounded meter is
  //      `inactivity_timeout_seconds` — which requires everyone to actually
  //      disconnect.
  const maxDurationSeconds = resolveMaxCallDurationSeconds(
    args.windowEndsAt ? { endsAt: args.windowEndsAt } : null,
    args.startsAt,
  );

  const custom = buildCallCustom({
    occurrenceId: args.occurrenceId,
    appointmentId: args.appointmentId,
    appointmentType: args.appointmentType,
    organizationId: args.organizationId ?? null,
    identity,
    startsAt: args.startsAt,
    windowEndsAt: args.windowEndsAt,
  });

  const settings_override =
    maxDurationSeconds !== null
      ? { limits: { max_duration_seconds: maxDurationSeconds } }
      : undefined;

  const members = identity?.members ?? [];

  return {
    data: {
      created_by_id: authorUserId,
      starts_at: args.startsAt,
      // Omitted entirely when the run could not be resolved. A guessed cap is
      // worse than none: the call type carries no limit of its own, so leaving
      // it out is exactly the behaviour before this backstop existed.
      ...(settings_override ? { settings_override } : {}),
      custom,
      // #1134 P0-1 — once ensure-call-type-grants strips `join-call` from `user`
      // and `guest`, membership is the ONLY thing that admits anyone. A call
      // minted without members is still joinable via
      // POST /api/meetings/[id]/join, which grants membership itself.
      ...(members.length > 0 ? { members } : {}),
    },
    // The same keys as an update: what a repair asserts about the room. Note
    // `starts_at` is deliberately NOT here — this payload exists to heal
    // identity and the bound, and `starts_at` is set once at creation.
    update: {
      custom,
      ...(settings_override ? { settings_override } : {}),
    },
    // The author may not be among the named members on the fallback path.
    syncUserIds: [
      ...new Set([authorUserId, ...members.map((member) => member.user_id)]),
    ],
  };
}

/**
 * The reconcile step: our keys, merged onto what the room already holds.
 *
 * Stream REPLACES the `custom` object on update; it does not merge. Sending
 * only our keys would therefore delete every other one — including the host
 * fields `useSessionInfo()` reads to decide who may end the call, and whatever
 * an operator or a later feature has since written into the room. So the room
 * is read first and our keys are laid over it.
 *
 * Members are never touched: `UpdateCallRequest` carries no `remove_members`, so
 * a reconcile cannot drop anyone, and the roster is repaired through the
 * idempotent `updateCallMembers` instead.
 *
 * @param currentCustom The call's own `custom` blob, as read back from Stream.
 * @param currentMaxDurationSeconds The cap currently on the call, as read back
 *   from `call.settings.limits` — an UNDEFINED value there means the effective
 *   cap, and must not be confused with 0.
 * @returns null when the room already agrees with us, which is the common case
 *   for a correctly minted room and the reason this is not a write on every
 *   join.
 */
export function buildMergingCallUpdate(args: {
  currentCustom: Record<string, unknown> | null | undefined;
  currentMaxDurationSeconds: number | null | undefined;
  authoritative: UpdateCallRequest;
}): UpdateCallRequest | null {
  const authoritativeCustom = args.authoritative.custom ?? {};
  const merged = { ...(args.currentCustom ?? {}), ...authoritativeCustom };

  const authoritativeCap =
    args.authoritative.settings_override?.limits?.max_duration_seconds;
  const capChanged =
    authoritativeCap !== undefined &&
    authoritativeCap !== args.currentMaxDurationSeconds;

  const customChanged = !sameCustomBlob(args.currentCustom, merged);
  if (!customChanged && !capChanged) return null;

  return {
    custom: merged,
    ...(capChanged
      ? { settings_override: args.authoritative.settings_override }
      : {}),
  };
}

/**
 * Key-order-independent comparison, because `JSON.stringify` is not: two objects
 * with the same entries in a different order are the same blob, and writing it
 * back anyway would be a write on every single join.
 *
 * Canonicalised rather than compared key-by-key because a value here can be an
 * ARRAY — `hostUserIds` is one, and `Object.is` on two equal-but-distinct arrays
 * is false, which would make every join a write and quietly turn the "skip when
 * unchanged" path off.
 */
function sameCustomBlob(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown>,
): boolean {
  return canonical(a ?? {}) === canonical(b);
}

/** Stable JSON: object keys sorted at every depth, so order cannot decide it. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    return `{${entries
      .map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The `custom` blob a session's call carries.
 *
 * #1270 — every field here used to be assembled in the browser and handed to
 * Stream by the browser, so the person who clicked Join first decided what the
 * room said about itself, including `consultantUserId`, which is what the
 * meeting UI derives host-ness from. All of it is read from the same rows the
 * entitlement gate reads.
 */
function buildCallCustom(args: {
  occurrenceId: string;
  appointmentId: string | null | undefined;
  appointmentType: AppointmentsType;
  organizationId: string | null;
  identity: RoomIdentityProfile | null;
  startsAt: Date;
  windowEndsAt: Date | null;
}): Record<string, unknown> {
  const { identity } = args;
  const { title, description } = describeCall(
    args.appointmentType,
    args.appointmentId,
    identity,
  );

  // #org-appts — which SIDE of the appointment each viewer is on, resolved from
  // resolvePlanOwnerIds and slot membership rather than accepted from the
  // caller. `consultantUserId` stays the owner for calls and screens minted
  // before #1580; `hostUserIds` is the owner plus the accepted co-presenter.
  const consultantUserId = identity?.hostUserIds[0] ?? null;
  const consulteeUserId = identity?.guestUserIds[0] ?? null;
  const hostUserIds = identity?.hostControlUserIds ?? [];

  return {
    title,
    description,
    appointmentId: args.appointmentId ?? null,
    // #1554 — the occurrence keys the room; `slotId` stays for the screens
    // that read it.
    slotId: args.occurrenceId,
    occurrenceId: args.occurrenceId,
    appointmentType: args.appointmentType,
    ...(args.organizationId ? { organizationId: args.organizationId } : {}),
    ...(consultantUserId ? { consultantUserId } : {}),
    ...(hostUserIds.length > 0 ? { hostUserIds } : {}),
    ...(consulteeUserId ? { consulteeUserId } : {}),
    // #1070 — the session's real shape. `CallRequest` has no `ends_at`, so the
    // end travels as call metadata. Written whenever a window was resolvable,
    // which for a recovered room is always: it comes from the committed
    // occurrence row, the same source the planner edit writes through
    // (lib/meetings/sync-call-window.ts).
    ...(args.windowEndsAt
      ? {
          sessionStartsAt: args.startsAt.toISOString(),
          sessionEndsAt: args.windowEndsAt.toISOString(),
          sessionDurationMinutes: Math.max(
            Math.round(
              (args.windowEndsAt.getTime() - args.startsAt.getTime()) / 60_000,
            ),
            0,
          ),
          ...(identity?.offeringTitle
            ? { offeringTitle: identity.offeringTitle }
            : {}),
          // Both sides by name, so each screen can lead with the OTHER one.
          ...(identity?.hostName ? { hostName: identity.hostName } : {}),
          ...(identity?.guestName ? { guestName: identity.guestName } : {}),
        }
      : {}),
  };
}

function describeCall(
  appointmentType: AppointmentsType,
  appointmentId: string | null | undefined,
  identity: RoomIdentityProfile | null,
): { title: string; description: string } {
  const offeringTitle = identity?.offeringTitle ?? null;
  // The consultee, by name. Group events name no guests at all, so this is
  // null for a webinar or a class and the offering branches below take over —
  // which is the same precedence the browser-side version had.
  const guestName = identity?.guestName ?? null;

  if (guestName) {
    return {
      title: `${appointmentType} with ${guestName}`,
      description: `${appointmentType} Meeting`,
    };
  }
  if (appointmentType === "WEBINAR" && offeringTitle) {
    return {
      title: `Webinar: ${offeringTitle}`,
      description: `Webinar Session for ${offeringTitle}`,
    };
  }
  if (appointmentType === "CLASS" && offeringTitle) {
    return {
      title: `Class: ${offeringTitle}`,
      description: `Class Session for ${offeringTitle}`,
    };
  }
  return {
    title: `Meeting for Appointment ${appointmentId ?? "unknown"}`,
    description: `${appointmentType} Meeting`,
  };
}
