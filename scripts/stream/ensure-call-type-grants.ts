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
 * name at creation (lib/meeting.ts) and the call-scoped tokens minted by
 * /api/meetings/[id]/join-token, Stream refuses a non-member itself.
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
 *   npx tsx scripts/stream/ensure-call-type-grants.ts --apply --restore-user-join
 */
import "dotenv/config";
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

/**
 * Permissions no ordinary participant should hold, also verified live: `user`
 * currently has BOTH. Any attendee could end the call for everyone, or start a
 * recording, straight from devtools — which also walks straight around the
 * consent gate in /api/stream/recordings/start, since that gate only guards our
 * own endpoint and not a direct client SDK call.
 */
const HOST_ONLY_PERMISSIONS = ["end-call", "start-recording", "stop-recording"];

/** The role every legitimate participant is given by /api/meetings/[id]/join. */
const MEMBER_ROLE = "call_member";

interface Options {
  apply: boolean;
  restore: boolean;
}

function parseArgs(argv: string[]): Options {
  return {
    apply: argv.includes("--apply"),
    restore: argv.includes("--restore-user-join"),
  };
}

export async function ensureCallTypeGrants(opts: Options): Promise<number> {
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
    // Deliberately does NOT restore end-call / start-recording to `user`.
    // Reverting the join change is an availability rollback; handing every
    // participant the ability to end a call again is not part of that.
  } else {
    for (const role of JOIN_REVOKED_ROLES) {
      const roleGrants = grants[role];
      if (roleGrants) {
        grants[role] = roleGrants.filter(
          (g) => g !== JOIN_CALL && !HOST_ONLY_PERMISSIONS.includes(g),
        );
      }
    }
    // call_member is what /api/meetings/[id]/join assigns, so it MUST keep
    // join-call. It already holds it on the live type; assert rather than
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
    const before = (existing.grants[role] ?? []).includes(JOIN_CALL);
    const now = (grants[role] ?? []).includes(JOIN_CALL);
    console.log(
      `  ${role.padEnd(12)} join-call: ${before} → ${now}` +
        (grants[role] ? "" : "   (role absent on this call type)"),
    );
  }
  for (const perm of HOST_ONLY_PERMISSIONS) {
    console.log(
      `  user.${perm.padEnd(20)}: ${(existing.grants.user ?? []).includes(perm)} → ${(grants.user ?? []).includes(perm)}`,
    );
  }

  // Refuse to write a configuration that locks everyone out. The join route
  // assigns call_member; if that role cannot join, nobody can.
  if (!opts.restore && !(grants[MEMBER_ROLE] ?? []).includes(JOIN_CALL)) {
    console.error(
      `\nREFUSING: ${MEMBER_ROLE} would not hold ${JOIN_CALL}. Every participant would be locked out.`,
    );
    return 1;
  }

  if (!opts.apply) {
    console.log("\n(dry run — re-run with --apply to write this to Stream)");
    return 0;
  }

  await client.video.updateCallType({ name: STREAM_CALL_TYPE, grants });
  console.log(`\n✅ applied. Revert with: --apply --restore-user-join`);
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
