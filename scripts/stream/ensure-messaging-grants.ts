/**
 * Removes the owner-scoped truncate, delete, recreate, update and member-update grants from the
 * `user` role of the `messaging` chat channel type. Grants replace per role, so it derives the new
 * `user` list from the live one and writes only that role.
 *
 *   npx tsx scripts/stream/ensure-messaging-grants.ts
 *   npx tsx scripts/stream/ensure-messaging-grants.ts --apply
 */
import "dotenv/config";
import { getStreamChatClient, isStreamConfigured } from "@/lib/stream-client";
import {
  MESSAGING_CHANNEL_TYPE,
  MESSAGING_USER_REVOKED_GRANTS,
  grantDifferences,
  intendedMessagingGrants,
} from "@/lib/stream/control-plane-contract";

export interface EnsureMessagingGrantsOptions {
  apply: boolean;
}

function parseArgs(argv: string[]): EnsureMessagingGrantsOptions {
  return { apply: argv.includes("--apply") };
}

export async function ensureMessagingGrants(
  opts: EnsureMessagingGrantsOptions,
): Promise<number> {
  if (!isStreamConfigured()) {
    console.error(
      "Stream is not configured — set STREAM_API_KEY and STREAM_API_SECRET",
    );
    return 1;
  }

  const client = getStreamChatClient();
  const before = await client.getChannelType(MESSAGING_CHANNEL_TYPE);
  const intended = intendedMessagingGrants(before.grants);
  const changes = grantDifferences(before.grants, intended);

  if (changes.length === 0) {
    console.log(
      `✅ channel type "${MESSAGING_CHANNEL_TYPE}" already has the desired grants — no change`,
    );
    return 0;
  }

  console.log(`Channel type: ${MESSAGING_CHANNEL_TYPE}`);
  for (const change of changes) console.log(`  revoke ${change}`);

  if (!opts.apply) {
    console.log("\n(dry run — re-run with --apply to write this to Stream)");
    return 0;
  }

  await client.updateChannelType(MESSAGING_CHANNEL_TYPE, {
    grants: { user: intended.user },
  });
  const after = await client.getChannelType(MESSAGING_CHANNEL_TYPE);

  if (
    (after.grants.user ?? []).some((perm) =>
      MESSAGING_USER_REVOKED_GRANTS.includes(perm),
    )
  ) {
    console.error(
      `\n🚨 Stream still stores an owner grant on the "user" role of "${MESSAGING_CHANNEL_TYPE}".`,
    );
    return 1;
  }
  const unexpected = grantDifferences(after.grants, intended);
  if (unexpected.length > 0) {
    console.error(
      `\n🚨 The write changed grants it was not given: ${unexpected.join(", ")}`,
    );
    return 1;
  }

  console.log(`\n✅ applied — "${MESSAGING_CHANNEL_TYPE}" grants verified.`);
  return 0;
}

if (require.main === module) {
  ensureMessagingGrants(parseArgs(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("Failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
