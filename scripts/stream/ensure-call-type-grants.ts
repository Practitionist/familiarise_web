/**
 * #1134 P0-1 — move `join-call` off the plain `user` role.
 *
 * Stream's `default` call type grants `join-call` to `user`, which means any
 * holder of a valid token for the app can join any call by id. Our call ids are
 * deterministic (`slot-<anchorSlotId>`) and slot ids travel in availability
 * payloads, so a signed-in stranger could open a private consultation from
 * devtools. The app-side check was a React conditional and stopped nothing.
 *
 * This moves `join-call` to `call_member`. Combined with the members we already
 * name at creation (lib/meeting.ts) and the membership that
 * app/api/meetings/[meetingId]/join grants server-side after
 * resolveMeetingAccess passes, Stream refuses a non-member itself. There are no
 * call-scoped tokens: the video client is an app-wide singleton holding one user
 * token, so `call_cids` would have meant a second client per meeting.
 *
 * We harden `default` in place rather than minting a bespoke type because a
 * call's type is immutable: a new type would protect only future calls and leave
 * every existing one open.
 *
 * Idempotent and reversible. Dry-run is the default — pass `--apply` to write.
 * Reverting is the same script with `--restore-user-join`.
 *
 *   npx tsx scripts/stream/ensure-call-type-grants.ts
 *   npx tsx scripts/stream/ensure-call-type-grants.ts --apply
 *   npx tsx scripts/stream/ensure-call-type-grants.ts --apply --join-route-is-deployed
 *   npx tsx scripts/stream/ensure-call-type-grants.ts --apply --restore-user-join
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStreamVideoClient, isStreamConfigured } from "../../lib/stream-client";
import { STREAM_CALL_TYPE } from "../../lib/stream/call-cid";

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

/** The role every participant is given by /api/meetings/[meetingId]/join. */
const MEMBER_ROLE = "call_member";

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
 * `end-call` is deliberately NOT revoked from `call_member`. EndCallButton.tsx
 * calls `call.endCall()` client-side, and the Stream role no longer separates
 * host from participant — host-ness is derived from `custom.consultantUserId` —
 * so revoking it here would take the host's End Call button down with it.
 *
 * That leaves any participant able to end a call for everyone. Closing it needs
 * a server-side End Call route or a host-only role first, so it is tracked
 * separately rather than half-done here. Still revoked from `user`/`guest` as
 * defence in depth, in case role assignment ever changes.
 */
const END_CALL = "end-call";

/** Everything an ordinary participant can hold, recording-wise. */
const RECORDING_REVOKED_ROLES = [...JOIN_REVOKED_ROLES, MEMBER_ROLE];

/**
 * Stable stringify for comparing two separate `getCallType` reads.
 *
 * Plain `JSON.stringify` preserves key insertion order, and the two snapshots
 * come from two independent responses — so an identical configuration whose keys
 * arrived in a different order would report as drift, write a pre-image, and
 * tell the operator Stream discarded settings it had not touched. A false alarm
 * on this particular check is expensive: it is the thing that says whether a
 * production config wipe just happened.
 *
 * Code-unit ordering, never `localeCompare` — same rule as the channel ids.
 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : val,
  );
}

interface Options {
  apply: boolean;
  restore: boolean;
  deployConfirmed: boolean;
}

function parseArgs(argv: string[]): Options {
  return {
    apply: argv.includes("--apply"),
    restore: argv.includes("--restore-user-join"),
    deployConfirmed: argv.includes("--join-route-is-deployed"),
  };
}

/**
 * The order this script runs in relative to the deploy is load-bearing, and
 * getting it wrong locks every user out of every call.
 *
 * Applying strips `join-call` from the `user` role. Nobody can then join except
 * as a `call_member`, and the ONLY thing that makes anyone a `call_member` is
 * `POST /api/meetings/[meetingId]/join`. Run this before that route is live and
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
      "\nThis strips `join-call` from the `user` role. After it, the only way to\n" +
      "join a call is to hold `call_member`, and the only thing that grants that\n" +
      "is POST /api/meetings/[meetingId]/join. If that route is not deployed and\n" +
      "serving traffic RIGHT NOW, every user is locked out of every call from the\n" +
      "moment this write lands.\n" +
      "\nDeploy first. Confirm the route is live. Then re-run with:\n" +
      "  npx tsx scripts/stream/ensure-call-type-grants.ts --apply --join-route-is-deployed\n" +
      "\nIf you get it wrong, the rollback is:\n" +
      "  npx tsx scripts/stream/ensure-call-type-grants.ts --apply --restore-user-join\n",
  );
  return false;
}

export async function ensureCallTypeGrants(opts: Options): Promise<number> {
  // Before anything else, including the read — a refusal should not depend on
  // Stream being reachable.
  if (!requireDeployConfirmation(opts)) return 1;

  if (!isStreamConfigured()) {
    console.error("Stream is not configured — set STREAM_API_KEY and STREAM_API_SECRET");
    return 1;
  }

  const client = getStreamVideoClient();
  const existing = await client.video.getCallType({ name: STREAM_CALL_TYPE });

  const grants: Record<string, string[]> = { ...existing.grants };

  const before = JSON.stringify(grants, null, 2);

  if (opts.restore) {
    for (const role of JOIN_REVOKED_ROLES) {
      const roleGrants = grants[role];
      if (roleGrants && !roleGrants.includes(JOIN_CALL)) {
        grants[role] = [...roleGrants, JOIN_CALL];
      }
    }
    // Deliberately does NOT restore end-call or recording control. Reverting the
    // join change is an availability rollback; handing every participant the
    // ability to end a call or start a recording again is not part of that.
  } else {
    // `user` and `guest` lose the lot — they should not be joining at all.
    for (const role of JOIN_REVOKED_ROLES) {
      const roleGrants = grants[role];
      if (roleGrants) {
        grants[role] = roleGrants.filter(
          (g) =>
            g !== JOIN_CALL &&
            g !== END_CALL &&
            !RECORDING_PERMISSIONS.includes(g),
        );
      }
    }

    // `call_member` keeps join-call (it is what the join route assigns) and
    // keeps end-call (EndCallButton needs it), but loses recording control.
    for (const role of RECORDING_REVOKED_ROLES) {
      const roleGrants = grants[role];
      if (roleGrants) {
        grants[role] = roleGrants.filter(
          (g) => !RECORDING_PERMISSIONS.includes(g),
        );
      }
    }

    // call_member is what /api/meetings/[meetingId]/join assigns, so it MUST
    // keep join-call. It already holds it on the live type; assert rather than
    // assume, because getting this wrong locks every paying user out of every
    // call.
    const memberGrants = grants[MEMBER_ROLE] ?? [];
    if (!memberGrants.includes(JOIN_CALL)) {
      grants[MEMBER_ROLE] = [...memberGrants, JOIN_CALL];
    }
  }

  const after = JSON.stringify(grants, null, 2);

  if (before === after) {
    console.log(`✅ call type "${STREAM_CALL_TYPE}" already has the desired grants — no change`);
    return 0;
  }

  console.log(`Call type: ${STREAM_CALL_TYPE}`);
  for (const role of [...JOIN_REVOKED_ROLES, MEMBER_ROLE, "admin"]) {
    const had = (existing.grants[role] ?? []).includes(JOIN_CALL);
    const now = (grants[role] ?? []).includes(JOIN_CALL);
    console.log(
      `  ${role.padEnd(12)} join-call: ${had} → ${now}` +
        (grants[role] ? "" : "   (role absent on this call type)"),
    );
  }
  for (const role of RECORDING_REVOKED_ROLES) {
    for (const perm of [...RECORDING_PERMISSIONS, END_CALL]) {
      const had = (existing.grants[role] ?? []).includes(perm);
      const now = (grants[role] ?? []).includes(perm);
      if (had === now && !had) continue;
      console.log(
        `  ${role.padEnd(12)} ${perm.padEnd(16)}: ${had} → ${now}` +
          (perm === END_CALL && role === MEMBER_ROLE
            ? "   (kept — EndCallButton calls call.endCall())"
            : ""),
      );
    }
  }

  // There used to be a guard here refusing to write a config where call_member
  // lacked join-call. It could never fire: the block above unconditionally adds
  // join-call to call_member a few lines earlier, so the condition was false by
  // construction — a safety net that read as protection and executed no
  // branches, which is the second time that exact shape has appeared in this
  // file. The check that matters is on the way back, against what Stream
  // actually stored, and it lives in the verification below.

  if (!opts.apply) {
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

  await client.video.updateCallType({ name: STREAM_CALL_TYPE, grants });

  const verify = await client.video.getCallType({ name: STREAM_CALL_TYPE });
  const settingsAfter = canonical(verify.settings);
  const notificationsAfter = canonical(verify.notification_settings);

  // The one invariant worth checking against real returned data rather than
  // against our own intent: the join route assigns `call_member`, so if Stream
  // did not store join-call on that role, every participant is locked out of
  // every call. Checked here, after the write, where it can genuinely fail.
  if (!opts.restore && !(verify.grants[MEMBER_ROLE] ?? []).includes(JOIN_CALL)) {
    console.error(
      `\n🚨 ${MEMBER_ROLE} does NOT hold ${JOIN_CALL} on Stream after this write.` +
        `\n   Every participant is locked out of every call. Roll back NOW:` +
        `\n     npx tsx scripts/stream/ensure-call-type-grants.ts --apply --restore-user-join`,
    );
    return 1;
  }

  if (settingsAfter !== settingsBefore || notificationsAfter !== notificationsBefore) {
    // Written to a file, not just stderr. This is the only copy of the config
    // Stream just discarded, the `settings` block is a couple of kilobytes of
    // recording layout, and an operator who scrolls away or closes the terminal
    // has lost the one thing that can undo this. Sentry is not the answer here:
    // nothing in .github/workflows runs this script, so it is always a human at
    // a laptop, where initJobSentry deliberately disables reporting (#901).
    const preImagePath = join(
      tmpdir(),
      `stream-call-type-${STREAM_CALL_TYPE}-preimage.json`,
    );
    const preImage = JSON.stringify(
      {
        callType: STREAM_CALL_TYPE,
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
      console.error(`(could not write the pre-image to ${preImagePath}:`, err, ")");
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

  console.log(`\n✅ applied — settings and notification_settings verified unchanged.`);
  console.log(`   Revert the grants with: --apply --restore-user-join`);
  return 0;
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
