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

/** Roles that must never lose the ability to join. */
const PRIVILEGED_ROLES = ["admin", "moderator", "host", "call_member"];

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

  const userGrants = grants.user ?? [];
  const memberGrants = grants.call_member ?? [];

  if (opts.restore) {
    if (!userGrants.includes(JOIN_CALL)) grants.user = [...userGrants, JOIN_CALL];
  } else {
    grants.user = userGrants.filter((g) => g !== JOIN_CALL);
    if (!memberGrants.includes(JOIN_CALL)) {
      grants.call_member = [...memberGrants, JOIN_CALL];
    }
    // Never lock ourselves out: an operator or a host must still be able to get
    // in even if membership was never written for a legacy call.
    for (const role of PRIVILEGED_ROLES) {
      const roleGrants = grants[role];
      if (roleGrants && !roleGrants.includes(JOIN_CALL)) {
        grants[role] = [...roleGrants, JOIN_CALL];
      }
    }
  }

  const after = JSON.stringify(grants, null, 2);

  if (before === after) {
    console.log(`✅ call type "${STREAM_CALL_TYPE}" already has the desired grants — no change`);
    return 0;
  }

  console.log(`Call type: ${STREAM_CALL_TYPE}`);
  console.log(`  user.join-call        : ${userGrants.includes(JOIN_CALL)} → ${(grants.user ?? []).includes(JOIN_CALL)}`);
  console.log(`  call_member.join-call : ${memberGrants.includes(JOIN_CALL)} → ${(grants.call_member ?? []).includes(JOIN_CALL)}`);

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
