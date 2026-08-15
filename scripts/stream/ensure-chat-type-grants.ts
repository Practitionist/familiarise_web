/**
 * Move channel creation and membership changes off the client, on Stream's side.
 *
 * The chat counterpart of `ensure-call-type-grants.ts`. That script found that
 * Stream's `default` call type grants `join-call` to the plain `user` role, so
 * any signed-in account could join any call by id. The chat side has the same
 * shape of hole and nothing in this repo has ever touched it: the only
 * `updateAppSettings` call we make is `ensure-webhook-subscription.ts`, and it
 * writes `event_hooks` alone. Chat channel-type permissions are therefore
 * whatever Stream ships by default, which for `messaging` and `team` includes
 * `create-channel` for `user`.
 *
 * That default is what let a browser mint a channel. `ChannelSearch` called
 * `channel.watch()` on a client-computed id; `watch()` posts to the channel
 * query endpoint, which creates the channel when it is absent, with the caller
 * as `created_by` and no members. The result was a conversation titled with its
 * own raw id, reporting "No members", that accepted a message and vanished on
 * reload. `POST /api/stream/channels/open` fixes the app path. This closes the
 * door behind it, so a leaked token or a future component cannot reopen it.
 *
 * `guest` matters as much as `user`, for the same reason the call-type script
 * gives: the app has `guest_user_creation_disabled: false`, so guest sessions
 * are creatable client-side with nothing but the public API key we ship as
 * `NEXT_PUBLIC_STREAM_API_KEY`. Stripping only `user` would leave the hole open
 * behind a fix that claims to close it.
 *
 * Also sets `user_search_disallowed_roles`, which stops a client-side
 * `queryUsers` from enumerating the user base. Stream's own docs note that
 * `queryUsers` requires no special permission by default.
 *
 * Existing channels are unaffected — grants are evaluated per request against
 * the channel TYPE, not baked in at creation. That is the opposite of the call
 * type's immutability problem, and it is why this hardens the built-in types in
 * place rather than minting bespoke ones.
 *
 * Idempotent and reversible. Dry-run is the default.
 *
 *   npx tsx scripts/stream/ensure-chat-type-grants.ts
 *   npx tsx scripts/stream/ensure-chat-type-grants.ts --apply --open-route-is-deployed
 *   npx tsx scripts/stream/ensure-chat-type-grants.ts --apply --restore-user-create
 *
 * NOTE: dev, preview and production share one Stream app. A dry run here reads
 * production. An apply writes it.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getStreamChatClient, isStreamConfigured } from "../../lib/stream-client";

/** The two built-in channel types this app uses. Nothing else is in play. */
const CHANNEL_TYPES = ["messaging", "team"] as const;

/**
 * Roles that lose the ability to create channels and rewrite membership.
 *
 * Not `admin`: ADMIN/STAFF map to Stream's `admin` role via `mapRoleToStream`,
 * and the support surfaces rely on it. Not `channel_moderator` either — an
 * event host holds it and legitimately manages their own roster through
 * `addMemberToChannel`, which is server-side and bypasses these grants anyway.
 */
const REVOKED_ROLES = ["user", "guest"] as const;

/**
 * `create-channel` is the one that matters; `update-channel-members` is the
 * follow-up. Without the second, a user who is already in a channel can still
 * add anyone they like to it — which is how a private DM becomes a group.
 *
 * Stream's permission names are kebab-case in the grants arrays.
 */
const REVOKED_PERMISSIONS = ["create-channel", "update-channel-members"] as const;

/** Roles barred from client-side `queryUsers`. Same reasoning as above. */
const USER_SEARCH_DISALLOWED_ROLES = ["user", "guest"];

interface Options {
  apply: boolean;
  restore: boolean;
  deployConfirmed: boolean;
}

function parseArgs(argv: string[]): Options {
  return {
    apply: argv.includes("--apply"),
    restore: argv.includes("--restore-user-create"),
    deployConfirmed: argv.includes("--open-route-is-deployed"),
  };
}

/**
 * Stable stringify for comparing two independent reads.
 *
 * Plain `JSON.stringify` preserves key insertion order, and the snapshots come
 * from separate responses — so an identical configuration whose keys arrived in
 * a different order would report as drift and tell the operator Stream
 * discarded settings it never touched. A false alarm on this check is
 * expensive: it is the thing that says whether a production config wipe just
 * happened.
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

/**
 * Ordering against the deploy is load-bearing, and getting it wrong breaks chat
 * for everyone.
 *
 * Applying revokes `create-channel` from `user`. After that, the ONLY thing
 * that can bring a missing channel into existence for an ordinary account is
 * `POST /api/stream/channels/open` (plus the booking-time server paths). Run
 * this before that route is live and any conversation whose channel does not
 * yet exist becomes unopenable — which is precisely the set of conversations
 * the bug report was about.
 *
 * A post-apply read cannot catch it: the grants will be exactly as requested.
 * What it cannot see is whether anything server-side is left that creates
 * channels. So the operator asserts it, with a flag named after the assertion.
 */
function requireDeployConfirmation(opts: Options): boolean {
  if (!opts.apply || opts.restore || opts.deployConfirmed) return true;

  console.error(
    "\n🛑 Refusing to apply.\n" +
      "\nThis revokes `create-channel` from the `user` and `guest` roles. After\n" +
      "it, a channel that does not already exist can only be created server-side\n" +
      "— by booking approval, payment success, or POST /api/stream/channels/open.\n" +
      "If that route is not deployed and serving traffic RIGHT NOW, every search\n" +
      "result whose channel was never created becomes a dead link.\n" +
      "\nDeploy first. Confirm the route is live. Then re-run with:\n" +
      "  npx tsx scripts/stream/ensure-chat-type-grants.ts --apply --open-route-is-deployed\n" +
      "\nIf you get it wrong, the rollback is:\n" +
      "  npx tsx scripts/stream/ensure-chat-type-grants.ts --apply --restore-user-create\n",
  );
  return false;
}

export async function ensureChatTypeGrants(opts: Options): Promise<number> {
  // Before the read — a refusal should not depend on Stream being reachable.
  if (!requireDeployConfirmation(opts)) return 1;

  if (!isStreamConfigured()) {
    console.error(
      "Stream is not configured — set STREAM_API_KEY and STREAM_API_SECRET",
    );
    return 1;
  }

  const client = getStreamChatClient();

  let changed = false;
  const preImage: Record<string, unknown> = {};

  for (const channelType of CHANNEL_TYPES) {
    const existing = await client.getChannelType(channelType);
    const existingGrants = (existing.grants ?? {}) as Record<string, string[]>;
    preImage[channelType] = existingGrants;

    const grants: Record<string, string[]> = Object.fromEntries(
      Object.entries(existingGrants).map(([role, perms]) => [role, [...perms]]),
    );

    for (const role of REVOKED_ROLES) {
      const roleGrants = grants[role];
      // A role absent from this type's grants map is not an error — Stream's
      // built-in types do not all carry the same role keys, and inventing one
      // would grant permissions rather than remove them.
      if (!roleGrants) continue;

      if (opts.restore) {
        for (const perm of REVOKED_PERMISSIONS) {
          if (!roleGrants.includes(perm)) roleGrants.push(perm);
        }
      } else {
        grants[role] = roleGrants.filter(
          (g) => !REVOKED_PERMISSIONS.includes(g as never),
        );
      }
    }

    if (canonical(existingGrants) === canonical(grants)) {
      console.log(`✅ channel type "${channelType}" already correct — no change`);
      continue;
    }

    console.log(`Channel type: ${channelType}`);
    for (const role of REVOKED_ROLES) {
      if (!existingGrants[role]) {
        console.log(`  ${role.padEnd(8)} (role absent on this channel type)`);
        continue;
      }
      for (const perm of REVOKED_PERMISSIONS) {
        const had = (existingGrants[role] ?? []).includes(perm);
        const now = (grants[role] ?? []).includes(perm);
        console.log(`  ${role.padEnd(8)} ${perm.padEnd(24)} ${had} → ${now}`);
      }
    }

    if (!opts.apply) {
      changed = true;
      continue;
    }

    await client.updateChannelType(channelType, { grants });
    changed = true;
    console.log(`  written`);
  }

  // App-level: stop client-side user enumeration.
  // Asymmetry in stream-chat v9's types, not in the API: the field is declared
  // on the READ shape (`AppSettingsAPIResponse.app`) but missing from the WRITE
  // shape (`AppSettings`). Stream's own docs show it being written via
  // `updateAppSettings`, so the write below carries a narrow cast rather than a
  // workaround.
  const settings = await client.getAppSettings();
  const currentDisallowed = settings.app?.user_search_disallowed_roles ?? [];
  preImage.user_search_disallowed_roles = currentDisallowed;

  const desiredDisallowed = opts.restore ? [] : USER_SEARCH_DISALLOWED_ROLES;

  if (canonical([...currentDisallowed].sort()) !== canonical([...desiredDisallowed].sort())) {
    console.log(
      `App setting: user_search_disallowed_roles ` +
        `[${currentDisallowed.join(", ")}] → [${desiredDisallowed.join(", ")}]`,
    );
    if (opts.apply) {
      // NOTE: `updateAppSettings` REPLACES the field it is given rather than
      // merging — the trap documented at length in
      // ensure-webhook-subscription.ts. Only this one key is passed, so the
      // event_hooks that script manages are untouched.
      await client.updateAppSettings({
        user_search_disallowed_roles: desiredDisallowed,
      } as Parameters<typeof client.updateAppSettings>[0]);
      console.log("  written");
    }
    changed = true;
  } else {
    console.log("✅ user_search_disallowed_roles already correct — no change");
  }

  if (!changed) return 0;

  if (!opts.apply) {
    console.log("\n(dry run — pass --apply to write)");
    return 0;
  }

  // Pre-image on disk, after the write rather than before it: a snapshot is
  // only worth keeping if there is something to roll back to.
  const path = join(tmpdir(), `stream-chat-grants-preimage-${process.pid}.json`);
  writeFileSync(path, JSON.stringify(preImage, null, 2));
  console.log(`\nPre-image written to ${path}`);

  return 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(
    `Stream chat grants (${opts.apply ? "LIVE" : "DRY RUN"}${opts.restore ? ", RESTORE" : ""})...`,
  );
  process.exit(await ensureChatTypeGrants(opts));
}

if (
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module
) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
