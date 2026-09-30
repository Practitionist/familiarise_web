/**
 * #1134 P0-1 — move `join-call` off the plain `user` role.
 *
 * Stream's `default` call type grants `join-call` to `user`, which means any
 * holder of a valid token for the app can join any call by id. Our call ids are
 * deterministic (`occurrence-<occurrenceId>`) and occurrence ids travel in appointment
 * payloads, so a signed-in stranger could open a private consultation from
 * devtools. The app-side check was a React conditional and stopped nothing.
 *
 * This moves `join-call` to `call_member`. Combined with the members named at
 * creation (`provisionAppointmentMeeting` in actions/stream/meetings) and the
 * membership that app/api/meetings/[meetingId]/join grants server-side after
 * resolveMeetingAccess passes, Stream refuses a non-member itself. There are no
 * call-scoped tokens: the video client is an app-wide singleton holding one user
 * token, so `call_cids` would have meant a second client per meeting.
 *
 * #1270 — run scripts/stream/backfill-call-member-role.ts BEFORE this. Calls
 * minted before that change named their members `host`/`user`, neither of which
 * survives this write; the pre-flight below refuses to apply until at least one
 * member of an open call actually holds `call_member`.
 *
 * We harden `default` in place rather than minting a bespoke type because a
 * call's type is immutable: a new type would protect only future calls and leave
 * every existing one open.
 *
 * It also revokes `end-call` and recording control from `call_member`, which the
 * join route hands to every participant. Both are server-side now
 * (`/api/meetings/[meetingId]/end`, `/api/stream/recordings/{start,stop}`), so
 * the grants buy nothing legitimate and let any attendee end a paid session or
 * defeat the pre-join recording-consent gate.
 *
 * And it revokes the BILLABLE grants the first round of this fix never reached:
 * transcription, closed captions, broadcasting, and
 * `enable-noise-cancellation-any-team`. That last one is metered per
 * PARTICIPANT-minute, so a self-serve grant on the role every participant holds
 * is not a permissions oversight, it is a meter anybody in the room can turn on.
 * See BILLABLE_CALL_PERMISSIONS.
 *
 * `--check` is the CI mode: it never writes, annotates each finding, and exits
 * 2 on drift. Run daily by `.github/workflows/stream-calltype-drift.yml`. A
 * grants map configured in the Stream dashboard leaves no commit and no failing
 * test, so nothing else would notice it being reopened.
 *
 * `--apply` additionally requires the target app to be named — see
 * `target-guard.ts`. Dev, preview and production share one Stream app and there
 * is no way to tell from the credentials which one they point at.
 *
 * Idempotent and reversible. Dry-run is the default — pass `--apply` to write.
 * Reverting is the same script with `--restore-user-join`.
 *
 *   npx tsx scripts/stream/ensure-call-type-grants.ts
 *   npx tsx scripts/stream/ensure-call-type-grants.ts --check
 *   npx tsx scripts/stream/ensure-call-type-grants.ts --apply --routes-are-deployed
 *   npx tsx scripts/stream/ensure-call-type-grants.ts --apply --restore-user-join
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getStreamVideoClient,
  isStreamConfigured,
} from "../../lib/stream-client";
import { STREAM_CALL_TYPE } from "../../lib/stream/call-cid";
import { PRODUCTION_APP_NAME, requireNamedTargetApp } from "./target-guard";
// One implementation of the drift comparison, not three. This file,
// ensure-call-type-settings.ts and ensure-app-settings.ts each had their own;
// they must agree, because this is the check that decides whether an operator
// is told a production config was just wiped.
import { canonical } from "../../lib/stream/config-fingerprint";
// The role every participant is given by /api/meetings/[meetingId]/join, by the
// server-side mint, and by the backfill. Imported rather than restated: a typo
// in this one string is a total video outage, and the two scripts have to agree
// about it or the pre-flight below checks for a role nothing assigns.
import {
  anyOpenCallMemberHolds,
  MEMBER_ROLE,
} from "./backfill-call-member-role";

const JOIN_CALL = "join-call";

/**
 * Roles that lose `join-call`. Verified against the LIVE call type, not assumed:
 * the `default` grants map has exactly six keys — guest, user, call_member,
 * admin, global_read_only, global_admin. There is no `host` and no `moderator`
 * key, so an earlier draft that tried to "protect" those was a no-op.
 *
 * `guest` matters as much as `user`. It holds `join-call`, and the app has
 * `guest_user_creation_disabled: false` — guest sessions are creatable
 * client-side with nothing but the public API key, which we ship as
 * NEXT_PUBLIC_STREAM_API_KEY. Stripping only `user` would have left the hole
 * wide open behind a fix that claimed to close it.
 */
const JOIN_REVOKED_ROLES = ["user", "guest"];

/**
 * Recording control is server-only here: RecordingControls.tsx posts to
 * /api/stream/recordings/start and /stop, and there is not one client-side
 * `call.startRecording()` in the tree. So the grant buys nothing legitimate, and
 * it costs the pre-join consent gate its teeth — that gate guards our endpoint,
 * not a direct SDK call.
 *
 * Revoked from `call_member` as well as `user`/`guest`, which is the whole point.
 * The join route assigns `call_member` to EVERY participant, and the live type
 * gives `call_member` all three of these permissions — so stripping them from
 * `user` alone, as an earlier draft did, changed precisely nothing.
 */
const RECORDING_PERMISSIONS = ["start-recording", "stop-recording"];

/**
 * The rest of the billable grants, which the first round of this fix never
 * reached.
 *
 * Verified against the LIVE `default` type on 2026-09-29 rather than against
 * Stream's documentation, because documentation is what made the first round
 * incomplete: it lists five built-in roles including `host` and `moderator` and
 * spells the member role `call-member`, while the live grants map has exactly
 * six keys — `admin, call_member, global_admin, global_read_only, guest, user` —
 * with no `host`, no `moderator`, and an underscore. Reading the docs is how a
 * list ends up naming permissions nobody holds and omitting the ones everybody
 * does.
 *
 * What the live type actually grants `call_member` and `user`:
 *
 *   enable-noise-cancellation-any-team
 *     Self-serve, and METERED PER PARTICIPANT-MINUTE. This is the expensive
 *     one: an eleven-tile gallery that has noise cancellation on bills eleven
 *     times what the same call bills with it off, and the participant who turned
 *     it on does not know they spent anyone's money. Nothing in the app uses
 *     `@stream-io/audio-filters-web`, so the grant has no legitimate holder —
 *     and it sits on `guest` too, which the app's
 *     `guest_user_creation_disabled: true` now makes unmintable, so this is the
 *     third lock on the same door rather than the first.
 *
 *   start-transcription / stop-transcription
 *     Billed per CALL-MINUTE at roughly ten times a video minute, and
 *     transcription produces a durable artefact (a transcript of a private
 *     consultation) that no one asked to create. We disable the setting on the
 *     type as well (`ensure-call-type-settings.ts`), so this grant is a second
 *     lock — deliberately: the setting can be re-enabled in the dashboard by
 *     anyone with the app open, and the grant is what decides who may start it.
 *
 *   start-closed-captions / stop-closed-captions
 *     Real-time captions are an ACCESSIBILITY feature, so the capability stays
 *     reachable — through the server, through the `livestream` posture, and
 *     through a client that holds the grant deliberately. What does not stay is
 *     self-serve: a participant starting captions on a paid call is a cost the
 *     host did not agree to. So this is revoked from the ordinary roles here and
 *     `closed_caption_mode` is pinned to `available` on `livestream` rather than
 *     off — see `ensure-call-type-settings.ts`.
 *
 *   start-broadcasting / stop-broadcasting
 *     `broadcasting.enabled` is already `false` on `default` (verified live
 *     2026-09-29), so the setting stops the meter today. The grant is still
 *     wrong to leave in place: `start-broadcast-call` was never revoked either
 *     (#1160 recorded the same complaint about the permission), and a dashboard
 *     change that flips one boolean would re-arm every participant at once. A
 *     permission nobody holds costs nothing to remove and cannot be forgotten.
 *
 * `anonymous` is in the revoked-roles list below even though this call type has
 * no such key: `livestream` does, and the same filter is the one that has to be
 * right for both. Filtering a role that is absent is a no-op (the script checks
 * for the key before touching it), so listing it here costs nothing and removes
 * a reason for the two call types to need different lists.
 */
const BILLABLE_CALL_PERMISSIONS = [
  "start-transcription",
  "stop-transcription",
  "start-closed-captions",
  "stop-closed-captions",
  "start-broadcasting",
  "stop-broadcasting",
  "enable-noise-cancellation-any-team",
];

/**
 * Roles that lose the billable grants. `call_member` is the one that matters and
 * it is the one a first pass forgets: `/api/meetings/[meetingId]/join` hands
 * `call_member` to EVERY participant, so revoking from `user` and `guest` alone
 * removes permissions from nobody at all while reading exactly like a fix.
 */
const BILLABLE_REVOKED_ROLES = ["user", "guest", "anonymous", MEMBER_ROLE];

/**
 * `end-call` is now revoked from `call_member` too. This is the deploy the
 * previous revision of this comment was waiting for.
 *
 * The hole: the join route assigns `call_member` to EVERY participant, and the
 * live `default` type grants that role `end-call`. Stream's roles do not
 * separate host from participant here — host-ness is `custom.consultantUserId`,
 * an application concept Stream knows nothing about — so any attendee could end
 * a paid consultation for both sides from devtools. `EndCallButton`'s `isHost`
 * is a React conditional; it decides what renders, not what Stream permits.
 *
 * It could not be closed until the client stopped needing the grant.
 * `EndCallButton.tsx` used to call `call.endCall()` directly, so revoking would
 * have taken the host's own control down with it and left the hole open anyway.
 *
 * #1270 built the replacement and it is on `dev`:
 * `POST /api/meetings/[meetingId]/end` resolves access server-side, requires the
 * hosting side, and ends the call with the server client.
 * `app/meetings/[id]/components/EndCallButton.tsx` posts to it behind an
 * `endingRef` guard and a 10s bound, and no longer touches the SDK.
 *
 * So the revocation is safe the moment that bundle is serving traffic — and
 * unsafe before it, in exactly the same way and for exactly the same reason as
 * the `join-call` move above: hosts still on the old bundle would lose End Call
 * with nothing to replace it. `--routes-are-deployed` gates both, because both
 * ship in the same deploy — and the flag is plural for a reason, see parseArgs.
 */
const END_CALL = "end-call";

/** Everything an ordinary participant can hold, recording-wise. */
const RECORDING_REVOKED_ROLES = [...JOIN_REVOKED_ROLES, MEMBER_ROLE];

/**
 * Who loses `end-call`. Same set as recording: nobody joining as an ordinary
 * participant has a legitimate reason to hold it now that the button goes
 * through the server.
 */
const END_CALL_REVOKED_ROLES = RECORDING_REVOKED_ROLES;

/**
 * `livestream` — the other type this repository may resolve calls against, and
 * one nothing in this folder had hardened until #1301.
 *
 * It is ALSO in `harden-unused-call-types.ts`'s `UNUSED_TYPES`, and that list
 * deliberately still contains it: whether this app resolves webinar calls against
 * `livestream` is a migration decision, not a hardening one, and the hardening
 * list must not quietly pre-empt it either way. What this plan does is make the
 * type safe in BOTH futures — unusable as a cost centre if we never migrate to
 * it, not a privilege escalation if we do.
 */
const LIVESTREAM_CALL_TYPE = "livestream";

/**
 * The owner-suffixed destructive grants `call_member` and `user` hold there.
 *
 * Read off the live `livestream` type on 2026-09-29. `-owner` means "on a call
 * you own", and the point of that scope is that the OWNER is the host. Stream has
 * no concept of a host on this type — `host` is a role key this app never
 * assigns, and host-ness in the app is `custom.consultantUserId`, which Stream
 * knows nothing about — so `call_member` is handed to every participant and
 * `call_member` is holding `end-call-owner`.
 *
 * Which means any attendee of a webinar can end the broadcast, remove other
 * participants, promote them, and start and stop a paid recording. The first is
 * the availability incident; the rest are the integrity ones.
 *
 * The two roles are named together because on this type they are near-identical
 * maps — `user` and `call_member` hold the same list, differing only in
 * `join-call`-family entries — so a revocation applied to one and not the other
 * would leave the same capability reachable under the other name.
 */
const OWNER_DESTRUCTIVE_PERMISSIONS = [
  "end-call-owner",
  "join-backstage-owner",
  "start-recording-owner",
  "stop-recording-owner",
  "remove-call-member-owner",
  "update-call-member-role-owner",
  // The two `-owner` forms of the broadcasting starters, which is the same hole as
  // `start-broadcasting-owner`'s plain sibling in a different suit: an attendee
  // pushing an RTMP or HLS broadcast off a paid call is the capability #1160
  // complained about, and on this type `broadcasting.enabled` is `true` — the one
  // setting the settings script deliberately does NOT pin here, because a
  // broadcast is the entire point of the type. So the grant is the only thing
  // between an audience member and the bill.
  "start-broadcasting-owner",
  "stop-broadcasting-owner",
];

/**
 * Who loses them. `host` and `admin` are absent on purpose: they are the roles
 * that are SUPPOSED to own a call, and an operator has to be able to inspect and
 * end one. `global_admin` is platform staff. This is the mirror of
 * `BILLABLE_REVOKED_ROLES` — strip from the roles an end user can hold, and only
 * from those.
 */
const OWNER_DESTRUCTIVE_ROLES = ["call_member", "user", "guest", "anonymous"];

interface Options {
  apply: boolean;
  restore: boolean;
  deployConfirmed: boolean;
  /**
   * CI mode: report the diff, annotate it, and exit non-zero on drift without
   * writing. See {@link DRIFT_EXIT_CODE}.
   */
  check: boolean;
  /** Raw argv, so `--target-app` is honoured alongside the env var. */
  argv: readonly string[];
}

function parseArgs(argv: string[]): Options {
  return {
    apply: argv.includes("--apply"),
    restore: argv.includes("--restore-user-join"),
    // #1301 follow-up — the flag is what an operator types from memory; the
    // refusal message is what they read only AFTER being refused. Naming it
    // after the join route alone was a trap: verified on 2026-09-01, the join
    // route IS on prod and the END route is NOT, so an operator asserting
    // truthfully about the join route would have stripped `end-call` and taken
    // End Call away from every host — prod's `EndCallButton` still calls
    // `call.endCall()` client-side.
    //
    // The old spelling stays a working alias so any runbook, shell history or
    // pasted command keeps functioning. Being refused because you typed the
    // documented flag would be its own small outage.
    deployConfirmed:
      argv.includes("--routes-are-deployed") ||
      argv.includes("--join-route-is-deployed"),
    check: argv.includes("--check"),
    argv,
  };
}

/**
 * Distinct from 1 on purpose, and for exactly the reason
 * `ensure-webhook-subscription.ts` says it: 1 means the script could not
 * evaluate drift at all (Stream unconfigured, or unreachable), which is a
 * failure of the RUNNER, while 2 means it evaluated the live call type and there
 * really is drift. Both fail the scheduled job, and a log reader should not have
 * to guess which happened — a missing credential on the runner and a dashboard
 * edit that re-granted `enable-noise-cancellation-any-team` need completely
 * different responses.
 */
export const DRIFT_EXIT_CODE = 2;

/** GitHub Actions annotation; a plain line anywhere else. */
function annotate(message: string): void {
  console.error(
    process.env.GITHUB_ACTIONS ? `::error::${message}` : `ERROR: ${message}`,
  );
}

/**
 * The order this script runs in relative to the deploy is load-bearing, and
 * getting it wrong locks every user out of every call.
 *
 * Applying strips `join-call` from the `user` role. Nobody can then join except
 * as a `call_member`, and the only things that make anyone a `call_member` are
 * the server-side mint and `POST /api/meetings/[meetingId]/join` — and the mint
 * only ever runs once per session, when the room is first created, so the route
 * is what every EXISTING call depends on. Run this before that route is live and
 * there is a window in which no one can join anything.
 *
 * The post-apply guard below does not catch it. That guard checks whether
 * Stream stored `join-call` on `call_member`, which it will have — the grant is
 * present, there is simply nobody holding the role. It passes, and reports
 * success, for exactly the failure that matters here.
 *
 * This cannot be verified automatically. Every route on the production origin
 * answers 404 to an unauthenticated request, deployed or not, so there is no
 * external probe that distinguishes them. So the operator asserts it, with a
 * flag named after the thing being asserted.
 */
function requireDeployConfirmation(opts: Options): boolean {
  if (!opts.apply || opts.restore || opts.deployConfirmed) return true;

  console.error(
    "\n🛑 Refusing to apply.\n" +
      "\nThis write depends on TWO routes already serving production traffic.\n" +
      "\n1. It strips `join-call` from the `user` role. After it, the only way to\n" +
      "   join a call is to hold `call_member`, and the only thing that grants\n" +
      "   that is POST /api/meetings/[meetingId]/join. If that route is not live\n" +
      "   RIGHT NOW, every user is locked out of every call the moment this\n" +
      "   lands.\n" +
      "\n2. It strips `end-call` from `call_member`. Hosts still running an old\n" +
      "   bundle call `call.endCall()` directly and will silently lose End Call;\n" +
      "   the replacement is POST /api/meetings/[meetingId]/end.\n" +
      "\nBoth ship in the same deploy, so one flag asserts both.\n" +
      "\nDeploy first. Confirm the route is live. Then re-run with:\n" +
      "  npx tsx scripts/stream/ensure-call-type-grants.ts --apply --routes-are-deployed\n" +
      "\nIf you get it wrong, the rollback is:\n" +
      "  npx tsx scripts/stream/ensure-call-type-grants.ts --apply --restore-user-join\n",
  );
  return false;
}

/**
 * The check the post-apply guard cannot make: does anybody actually HOLD
 * `call_member`?
 *
 * The guard at the bottom of this file re-reads the call type and confirms
 * Stream stored `join-call` on `call_member`. That is necessary and it is not
 * the failure that matters. The grant will be there — it is written a few lines
 * above — and it admits nobody if no member has been given the role. Until
 * #1270 nothing ever assigned it at creation: the mint stamped `host` on the
 * consultant (a role key the live `default` type does not even have) and `user`
 * on everyone else, and only the join route ever wrote `call_member`, one
 * participant at a time.
 *
 * So the blind spot was total: a green run, a correct-looking grants map, and
 * every person in every live call locked out at the same instant. This asks the
 * question directly, against real member records, and refuses to write if the
 * answer is no.
 *
 * A Stream outage must not be read as "nobody holds the role" — that would turn
 * a transient failure into a refusal to ever apply. It is reported as its own
 * failure instead.
 */
async function requireSomeoneHoldsMemberRole(
  client: ReturnType<typeof getStreamVideoClient>,
  opts: Options,
): Promise<boolean> {
  if (!opts.apply || opts.restore) return true;

  let scan: Awaited<ReturnType<typeof anyOpenCallMemberHolds>>;
  try {
    scan = await anyOpenCallMemberHolds(client, MEMBER_ROLE);
  } catch (err) {
    console.error(
      `\n🛑 Refusing to apply — could not read call members from Stream.` +
        `\n   This check is what stands between a security fix and a total` +
        `\n   video outage, so an unanswered question is a refusal.\n`,
      err,
    );
    return false;
  }

  // No open calls at all is not evidence of anything, and refusing there would
  // make this script unrunnable on a quiet app or a fresh environment. Say so
  // rather than passing silently.
  if (scan.callsScanned === 0) {
    console.log(
      `ℹ️  No open calls to check — nobody can be locked out of a call that does not exist.`,
    );
    return true;
  }

  if (scan.found) return true;

  // #1270 review — a PARTIAL result is a refusal too. The check used to pass on
  // one member anywhere holding the role, so a mixed roster satisfied it and the
  // members who lacked the role were locked out by this very write.
  console.error(
    `\n🛑 Refusing to apply.\n` +
      `\nScanned ${scan.callsScanned} open call(s). ${scan.membersMissingRole} member(s)` +
      `\nacross ${scan.callsWithUncoveredMembers.length} call(s) do NOT hold \`${MEMBER_ROLE}\`.` +
      `\nAfter this write that role is the only thing that admits anyone, so each` +
      `\nof those members is locked out of a call they are entitled to join.` +
      (scan.callsWithUncoveredMembers.length > 0
        ? `\n\nAffected calls: ${scan.callsWithUncoveredMembers.slice(0, 10).join(", ")}` +
          (scan.callsWithUncoveredMembers.length > 10
            ? ` … and ${scan.callsWithUncoveredMembers.length - 10} more`
            : ``)
        : ``) +
      `\n\nBackfill the role first, then re-run:` +
      `\n  npx tsx scripts/stream/backfill-call-member-role.ts` +
      `\n  npx tsx scripts/stream/backfill-call-member-role.ts --apply\n`,
  );
  return false;
}

/**
 * One call type: read, transform, report, write, verify.
 *
 * The transform, the report and the post-write assertion are all supplied by the
 * plan rather than shared, because the two call types have almost nothing in
 * common: `default` is a consultation type where `call_member` is load-bearing
 * and `join-call` has to be proven still present, and `livestream` is a broadcast
 * type where nothing is load-bearing and the whole job is taking away the
 * owner's powers. Sharing the write, the pre-image and the settings-drift check
 * is the part that is genuinely the same and the part that has to be identical —
 * that check is what tells an operator their recording layout was just discarded.
 */
interface GrantsPlan {
  /** The call type's name in Stream. */
  name: string;
  /** Why this type is being touched, printed above the diff. */
  rationale: string;
  /** Whether `--restore-user-join` applies to this type at all. */
  restorable: boolean;
  /**
   * Pre-write gate, `--apply` only. The answer the grants transform cannot
   * compute for itself.
   */
  preflight?: (client: StreamVideoClient) => Promise<boolean>;
  build: (
    grants: Record<string, string[]>,
    existing: Record<string, string[]>,
    opts: Options,
  ) => Record<string, string[]>;
  /** One line per change, for the operator. */
  report: (
    existing: Record<string, string[]>,
    next: Record<string, string[]>,
  ) => string[];
  /**
   * Post-write assertion against what Stream STORED, not against intent.
   * Returns the reason to fail, or null.
   */
  assert: (
    verify: Record<string, string[]>,
    intended: Record<string, string[]>,
    opts: Options,
  ) => string | null;
}

type StreamVideoClient = ReturnType<typeof getStreamVideoClient>;

/** The `default` plan: every revocation #1134 and #1301 landed. */
const DEFAULT_PLAN: GrantsPlan = {
  name: STREAM_CALL_TYPE,
  rationale:
    "the type every consultation resolves against — join, end-call and the billable grants are all server-side now",
  restorable: true,
  preflight: (client) =>
    requireSomeoneHoldsMemberRole(client, {
      apply: true,
      restore: false,
      deployConfirmed: true,
      check: false,
      argv: [],
    }),

  build: (grants, existing, opts) => {
    const next: Record<string, string[]> = { ...grants };

    if (opts.restore) {
      for (const role of JOIN_REVOKED_ROLES) {
        const roleGrants = next[role];
        if (roleGrants && !roleGrants.includes(JOIN_CALL)) {
          next[role] = [...roleGrants, JOIN_CALL];
        }
      }
      // `call_member` gets `end-call` back as well, because this rollback exists
      // for one situation — the end route is not actually serving traffic — and
      // in that situation the host has no way to end a call at all. Restoring
      // join without it would fix the lockout and leave every host stranded in a
      // room they cannot close.
      const restoreMember = next[MEMBER_ROLE];
      if (restoreMember && !restoreMember.includes(END_CALL)) {
        next[MEMBER_ROLE] = [...restoreMember, END_CALL];
      }

      // Recording control is NOT restored, and `user`/`guest` get nothing back
      // beyond `join-call`. Those revocations carry no availability risk — there
      // is no client-side `call.startRecording()` in the tree to break — so
      // undoing them would only re-open holes this script closed.
      return next;
    }

    // `user` and `guest` lose the lot — they should not be joining at all.
    for (const role of JOIN_REVOKED_ROLES) {
      const roleGrants = next[role];
      if (roleGrants) {
        next[role] = roleGrants.filter(
          (g) =>
            g !== JOIN_CALL &&
            g !== END_CALL &&
            !RECORDING_PERMISSIONS.includes(g),
        );
      }
    }

    // `call_member` keeps join-call — it is what the join route assigns and the
    // only thing that admits anyone — but loses recording control and `end-call`.
    // Both are server-side now: /api/stream/recordings/{start,stop} and
    // /api/meetings/[meetingId]/end.
    for (const role of RECORDING_REVOKED_ROLES) {
      const roleGrants = next[role];
      if (roleGrants) {
        next[role] = roleGrants.filter(
          (g) => !RECORDING_PERMISSIONS.includes(g),
        );
      }
    }

    // The billable remainder: transcription, closed captions, broadcasting and
    // the per-participant-minute noise-cancellation grant. `call_member` is in
    // this list and it is the role that matters — see BILLABLE_CALL_PERMISSIONS.
    for (const role of BILLABLE_REVOKED_ROLES) {
      const roleGrants = next[role];
      if (roleGrants) {
        next[role] = roleGrants.filter(
          (g) => !BILLABLE_CALL_PERMISSIONS.includes(g),
        );
      }
    }

    for (const role of END_CALL_REVOKED_ROLES) {
      const roleGrants = next[role];
      if (roleGrants) {
        next[role] = roleGrants.filter((g) => g !== END_CALL);
      }
    }

    // call_member is what /api/meetings/[meetingId]/join assigns, so it MUST
    // keep join-call. It already holds it on the live type; assert rather than
    // assume, because getting this wrong locks every paying user out of every
    // call.
    const memberGrants = next[MEMBER_ROLE] ?? [];
    if (!memberGrants.includes(JOIN_CALL)) {
      next[MEMBER_ROLE] = [...memberGrants, JOIN_CALL];
    }
    return next;
  },

  report: (existing, next) => {
    const lines: string[] = [];
    for (const role of [...JOIN_REVOKED_ROLES, MEMBER_ROLE, "admin"]) {
      const had = (existing[role] ?? []).includes(JOIN_CALL);
      const now = (next[role] ?? []).includes(JOIN_CALL);
      lines.push(
        `  ${role.padEnd(12)} join-call: ${had} → ${now}` +
          (next[role] ? "" : "   (role absent on this call type)"),
      );
    }
    for (const role of RECORDING_REVOKED_ROLES) {
      for (const perm of [...RECORDING_PERMISSIONS, END_CALL]) {
        const had = (existing[role] ?? []).includes(perm);
        const now = (next[role] ?? []).includes(perm);
        if (had === now && !had) continue;
        lines.push(
          `  ${role.padEnd(12)} ${perm.padEnd(16)}: ${had} → ${now}` +
            (perm === END_CALL && role === MEMBER_ROLE
              ? "   (server-side now — POST /api/meetings/[meetingId]/end)"
              : ""),
        );
      }
    }
    // Printed on their own loop rather than folded into the one above, because
    // the reasons differ and the reasons are what an operator reads when
    // deciding whether to type the next command.
    // `enable-noise-cancellation-any-team` is the one to read twice: it is the
    // only grant on this call type that costs money per participant-minute, so an
    // eleven-tile gallery with it on bills eleven times what the same call bills
    // with it off.
    lines.push(
      ...revocationLines(
        existing,
        next,
        BILLABLE_REVOKED_ROLES,
        BILLABLE_CALL_PERMISSIONS,
      ),
    );
    return lines;
  },

  assert: (verify, intended, opts) => {
    // The one invariant worth checking against real returned data rather than
    // against our own intent: the join route assigns `call_member`, so if Stream
    // did not store join-call on that role, every participant is locked out of
    // every call. Checked after the write, where it can genuinely fail.
    if (!opts.restore && !(verify[MEMBER_ROLE] ?? []).includes(JOIN_CALL)) {
      return (
        `${MEMBER_ROLE} does NOT hold ${JOIN_CALL} on Stream after this write. ` +
        `Every participant is locked out of every call. Roll back NOW: ` +
        `npx tsx scripts/stream/ensure-call-type-grants.ts --apply --restore-user-join`
      );
    }

    // The mirror of the check above. Asserting an ABSENCE against returned data
    // matters as much as asserting the presence: a silently-ignored revocation
    // would leave every attendee able to end a paid consultation while this
    // script printed a green tick.
    if (!opts.restore && (verify[MEMBER_ROLE] ?? []).includes(END_CALL)) {
      return (
        `${MEMBER_ROLE} still holds ${END_CALL} on Stream after this write. ` +
        `Every attendee can still end a consultation for both sides. The grants ` +
        `write did not take effect as sent — re-read the call type and do not ` +
        `report this run as successful.`
      );
    }

    // The same argument, generalised to the whole billable list rather than one
    // permission. This is the check the #1301 half-landed fix never had: the run
    // that stripped `start-recording` printed a green tick while every attendee
    // still held `enable-noise-cancellation-any-team`, so a reader had no way to
    // tell the applied change from the ignored one. An absent value has to be
    // read back, not inferred from a write that returned 200.
    if (!opts.restore) {
      const stillGranted = BILLABLE_REVOKED_ROLES.flatMap((role) =>
        BILLABLE_CALL_PERMISSIONS.filter((perm) =>
          (verify[role] ?? []).includes(perm),
        ).map((perm) => `${role}:${perm}`),
      );
      if (stillGranted.length > 0) {
        return (
          `${stillGranted.length} billable grant(s) survived this write on ` +
          `Stream: ${stillGranted.join(", ")}. The grants write did not take ` +
          `effect as sent for everything it carried. Re-read the call type and ` +
          `do not report this run as successful.`
        );
      }
    }

    // The rollback needs verifying too, and used to get none: BOTH post-write
    // grant checks are gated on `!opts.restore`, so `--restore-user-join`
    // reached the settings comparison, found nothing moved, and returned 0 —
    // reporting success without ever asking whether the restoration landed.
    //
    // That is backwards. The rollback is the emergency path: it is reached when
    // the revocation has already locked people out, and "it worked" is the one
    // thing the operator cannot afford to be told wrongly. Only asserted when
    // this run actually intended to restore the grant, so a rollback of a call
    // type that never had it does not fail on a no-op.
    if (
      opts.restore &&
      (intended[MEMBER_ROLE] ?? []).includes(END_CALL) &&
      !(verify[MEMBER_ROLE] ?? []).includes(END_CALL)
    ) {
      return (
        `${MEMBER_ROLE} still lacks ${END_CALL} on Stream after the rollback. ` +
        `Hosts cannot end a call, which is the state this rollback exists to ` +
        `undo. Do NOT report this run as successful.`
      );
    }
    return null;
  },
};

/** The `livestream` plan: strip the owner's powers from every end-user role. */
const LIVESTREAM_PLAN: GrantsPlan = {
  name: LIVESTREAM_CALL_TYPE,
  rationale:
    "a broadcast type where `call_member` is handed to every participant and Stream has no host concept — the owner's powers are the attendee's powers",
  // `--restore-user-join` is a rollback for the `default` lockout. There is
  // nothing here to roll back: these revocations carry no availability risk on a
  // type this app does not yet resolve calls against, and a rollback that handed
  // them back would re-open a hole rather than fix an outage.
  restorable: false,

  build: (grants) => {
    const next: Record<string, string[]> = { ...grants };
    for (const role of OWNER_DESTRUCTIVE_ROLES) {
      const roleGrants = next[role];
      if (roleGrants) {
        next[role] = roleGrants.filter(
          (g) => !OWNER_DESTRUCTIVE_PERMISSIONS.includes(g),
        );
      }
    }
    // The billable list too, on the same reasoning and by the same code: noise
    // cancellation is metered per participant-minute, and `harden-unused-call-types.ts`
    // strips the billable STARTERS from this type but never the noise-cancellation
    // grant or any of the `stop-` half. Two scripts removing overlapping sets is
    // fine — they only ever remove — and one of them being the sole remover of
    // a metered grant is not.
    for (const role of BILLABLE_REVOKED_ROLES) {
      const roleGrants = next[role];
      if (roleGrants) {
        next[role] = roleGrants.filter(
          (g) => !BILLABLE_CALL_PERMISSIONS.includes(g),
        );
      }
    }
    return next;
  },

  report: (existing, next) =>
    revocationLines(
      existing,
      next,
      [...OWNER_DESTRUCTIVE_ROLES, ...BILLABLE_REVOKED_ROLES],
      [...OWNER_DESTRUCTIVE_PERMISSIONS, ...BILLABLE_CALL_PERMISSIONS],
    ),

  assert: (verify) => {
    const survived = [
      ...OWNER_DESTRUCTIVE_ROLES,
      ...BILLABLE_REVOKED_ROLES,
    ].flatMap((role) =>
      [...OWNER_DESTRUCTIVE_PERMISSIONS, ...BILLABLE_CALL_PERMISSIONS]
        .filter((perm) => (verify[role] ?? []).includes(perm))
        .map((perm) => `${role}:${perm}`),
    );
    if (survived.length > 0) {
      return (
        `${survived.length} destructive or billable grant(s) survived this ` +
        `write on ${LIVESTREAM_CALL_TYPE}: ${survived.join(", ")}. Re-read the ` +
        `call type and do not report this run as successful.`
      );
    }
    return null;
  },
};

/**
 * One report line per permission actually being taken away, and nothing for the
 * ones that were never there. Printing 6 roles x 13 permissions with `false →
 * false` on every run is how a diff list stops being read, and the entries that
 * matter — the metered one, the ones that end a broadcast — are exactly the ones
 * a wall of no-ops buries.
 */
function revocationLines(
  existing: Record<string, string[]>,
  next: Record<string, string[]>,
  roles: readonly string[],
  permissions: readonly string[],
): string[] {
  return roles.flatMap((role) =>
    permissions
      .filter(
        (perm) =>
          (existing[role] ?? []).includes(perm) &&
          !(next[role] ?? []).includes(perm),
      )
      .map(
        (perm) =>
          `  ${role.padEnd(12)} ${perm.padEnd(40)}: true → false` +
          (perm === "enable-noise-cancellation-any-team"
            ? "   (metered PER PARTICIPANT-MINUTE)"
            : perm === "end-call-owner"
              ? "   (any attendee could end the broadcast)"
              : ""),
      ),
  );
}

async function applyPlanTo(
  client: StreamVideoClient,
  plan: GrantsPlan,
  opts: Options,
): Promise<number> {
  const existing = await client.video.getCallType({ name: plan.name });
  const grants = plan.build({ ...existing.grants }, existing.grants, opts);
  const before = JSON.stringify(existing.grants, null, 2);
  const after = JSON.stringify(grants, null, 2);

  if (before === after) {
    console.log(
      `✅ call type "${plan.name}" already has the desired grants — no change`,
    );
    return 0;
  }

  console.log(`\nCall type: ${plan.name} — ${plan.rationale}`);
  const lines = plan.report(existing.grants, grants);
  for (const line of lines) console.log(line);

  if (opts.check) {
    // One annotation per call type rather than one per permission. A drift
    // annotation is a line in the Actions log that somebody has to read and act
    // on, and fourteen of them for one call type is a way of ensuring none are.
    // The `--apply --routes-are-deployed` in the message is deliberate: the
    // operator is told the whole command rather than left to construct one that
    // silently skips the deploy assertion.
    annotate(
      `Stream call-type grants drift on \`${plan.name}\`: ${lines.length} ` +
        `change(s) pending, including revocations an ordinary role should not ` +
        // #1829 — the command has to be one that CAN run. Every `--apply` goes
        // through `requireNamedTargetApp`, which refuses a bare command, so the
        // annotation used to spell out a remediation that was guaranteed to be
        // rejected. An operator who trusted it would conclude the guard is
        // broken. The point of printing the full command is that nobody has to
        // reconstruct it.
        `hold. Run: npx tsx scripts/stream/ensure-call-type-grants.ts --apply ` +
        `--routes-are-deployed --target-app ${PRODUCTION_APP_NAME}`,
    );
  }

  // There used to be a guard here refusing to write a config where call_member
  // lacked join-call. It could never fire: the block above unconditionally adds
  // join-call to call_member a few lines earlier, so the condition was false by
  // construction — a safety net that read as protection and executed no
  // branches, which is the second time that exact shape has appeared in this
  // file. The check that matters is on the way back, against what Stream
  // actually stored, and it lives in the verification below.

  if (!opts.apply) {
    if (opts.check) {
      // Drift found and nothing written: a scheduled/CI consumer has to be able
      // to tell "in sync" from "drift" by exit status alone, or the job it is
      // wired into cannot fail. A detector that always exits green detects
      // nothing, which is how `ensure-webhook-subscription.ts` went unused for
      // as long as it did.
      console.log(`\n(dry run — re-run with --apply to write this to Stream)`);
      return DRIFT_EXIT_CODE;
    }
    console.log("\n(dry run — re-run with --apply to write this to Stream)");
    return 0;
  }

  // Stream does not document whether updateCallType merges or replaces the
  // top-level fields it is not given, and this codebase has already been bitten
  // by the chat twin: `channel.update()` is a FULL REPLACE that deletes every
  // custom field absent from the payload. The `default` type carries a large
  // `settings` block (recording layout, transcription, limits, backstage) and a
  // populated `notification_settings`, so a replace here would be a silent,
  // wide-blast-radius config wipe.
  //
  // Re-sending them is not the fix: `CallSettingsResponse` is not assignable to
  // `CallSettingsRequest` (every nested type differs), so echoing the read back
  // would mean casting data we have not verified is request-shaped — which could
  // corrupt the config on its own. Instead: snapshot, apply, re-read, compare.
  // A wipe becomes loud and recoverable rather than silent, and the first real
  // run settles the question for good.
  const settingsBefore = canonical(existing.settings);
  const notificationsBefore = canonical(existing.notification_settings);

  await client.video.updateCallType({ name: plan.name, grants });

  const verify = await client.video.getCallType({ name: plan.name });
  const settingsAfter = canonical(verify.settings);
  const notificationsAfter = canonical(verify.notification_settings);

  const fault = plan.assert(verify.grants, grants, opts);
  if (fault) {
    console.error(`\n🚨 ${fault}`);
    return 1;
  }

  if (
    settingsAfter !== settingsBefore ||
    notificationsAfter !== notificationsBefore
  ) {
    // Written to a file, not just stderr. This is the only copy of the config
    // Stream just discarded, the `settings` block is a couple of kilobytes of
    // recording layout, and an operator who scrolls away or closes the terminal
    // has lost the one thing that can undo this. Sentry is not the answer here:
    // applying is always a human at a laptop, where initJobSentry deliberately
    // disables reporting (#901) — and the daily job that exists to catch this
    // runs `--check` and never reaches this branch.
    const preImagePath = join(
      tmpdir(),
      `stream-call-type-${plan.name}-preimage.json`,
    );
    const preImage = JSON.stringify(
      {
        callType: plan.name,
        settings: existing.settings,
        notification_settings: existing.notification_settings,
      },
      null,
      2,
    );
    try {
      writeFileSync(preImagePath, preImage);
    } catch (err) {
      // Falling back to stderr is worse but not nothing.
      console.error(
        `(could not write the pre-image to ${preImagePath}:`,
        err,
        ")",
      );
      console.error(preImage);
    }

    console.error(
      `\n⚠️  updateCallType CHANGED configuration it was not given.` +
        `\n   settings changed:              ${settingsAfter !== settingsBefore}` +
        `\n   notification_settings changed: ${notificationsAfter !== notificationsBefore}` +
        `\n\n   The grants change applied. Restore the rest from the pre-image at:` +
        `\n     ${preImagePath}\n`,
    );
    return 1;
  }

  console.log(
    `\n✅ applied — settings and notification_settings verified unchanged.`,
  );
  if (plan.restorable) {
    console.log(`   Revert the grants with: --apply --restore-user-join`);
  }
  return 0;
}

/**
 * `default` first, then `livestream`.
 *
 * If a run is abandoned partway it must be abandoned having fixed the type every
 * live consultation is sitting on. A per-type failure stops the run, because a
 * `--apply` that reported success for one type and quietly skipped the other
 * would leave the operator believing both were hardened.
 */
const PLANS: readonly GrantsPlan[] = [DEFAULT_PLAN, LIVESTREAM_PLAN];

export async function ensureCallTypeGrants(opts: Options): Promise<number> {
  // Before anything else, including the read — a refusal should not depend on
  // Stream being reachable.
  if (!requireDeployConfirmation(opts)) return 1;

  // And before the credential check, because a wrong app is the more dangerous
  // of the two and saying "Stream is not configured" first would send the
  // operator looking in the wrong place. `--restore-user-join` is a write and is
  // gated like one: the rollback for a total video outage is not a moment to
  // relax the one check that says which account is being written to.
  if (
    !requireNamedTargetApp({
      script: "scripts/stream/ensure-call-type-grants.ts",
      writes: opts.apply,
      argv: opts.argv,
    })
  ) {
    return 1;
  }

  if (!isStreamConfigured()) {
    console.error(
      "Stream is not configured — set STREAM_API_KEY and STREAM_API_SECRET",
    );
    return 1;
  }

  const client = getStreamVideoClient();

  // The pre-flight, once and only for the type it is about: it asks whether
  // anybody HOLDS `call_member` on `default`, and `livestream` has no such role
  // to hold. `preflight` returns true for a dry run, a rollback and a check —
  // only a real `--apply` is refused, and only for the plan that can be locked
  // out by its own write.
  if (opts.apply && !opts.restore && DEFAULT_PLAN.preflight) {
    if (!(await DEFAULT_PLAN.preflight(client))) return 1;
  }

  let worst = 0;
  for (const plan of PLANS) {
    const code = await applyPlanTo(client, plan, opts);
    if (code === 1) return 1;
    if (code === DRIFT_EXIT_CODE) worst = DRIFT_EXIT_CODE;
  }
  return worst;
}

if (require.main === module) {
  ensureCallTypeGrants(parseArgs(process.argv.slice(2)))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error("ensure-call-type-grants failed:", err);
      process.exitCode = 1;
    });
}
