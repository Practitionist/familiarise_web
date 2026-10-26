/**
 * Make chat text-only: disable uploads on the `messaging` and `team` channel
 * types and strip the base attachment grants from every role.
 *
 *   npx tsx scripts/stream/ensure-chat-text-only.ts
 *   npx tsx scripts/stream/ensure-chat-text-only.ts --apply
 *
 * Writes a pre-image backup before changing anything and re-reads the channel
 * type afterwards, so a partial write is visible rather than assumed.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { getStreamChatClient, isStreamConfigured } from "@/lib/stream-client";

const CHANNEL_TYPES = ["messaging", "team"] as const;
// The `-owner` / `-any-team` attachment grants and the giphy command stay: GIFs
// are attachments, and `uploads: false` is what blocks files (those go through documents).
const ATTACHMENT_ACTIONS = new Set([
  "upload-file",
  "upload-attachment",
  "create-attachment",
]);
const BACKUP_DIR = ".stream-backups";

type Options = {
  apply: boolean;
};

function parseArgs(argv: string[]): Options {
  return { apply: argv.includes("--apply") };
}

function grantedUploadRoles(grants: Record<string, string[]>): string[] {
  return Object.entries(grants)
    .filter(([, actions]) =>
      actions.some((action) => ATTACHMENT_ACTIONS.has(action)),
    )
    .map(([role]) => role)
    .sort((a, b) => a.localeCompare(b));
}

function withoutUploadGrant(
  grants: Record<string, string[]>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(grants).map(([role, actions]) => [
      role,
      actions.filter((action) => !ATTACHMENT_ACTIONS.has(action)),
    ]),
  );
}

async function ensureChannelType(
  name: (typeof CHANNEL_TYPES)[number],
  opts: Options,
): Promise<boolean> {
  const client = getStreamChatClient();
  const before = await client.getChannelType(name);
  const uploadRoles = grantedUploadRoles(before.grants);
  if (before.uploads === false && uploadRoles.length === 0) {
    console.log(`\n${name}: text-only already — no change, and no write.`);
    return true;
  }

  console.log(`\n${name}:`);
  console.log(`  uploads            = ${before.uploads} -> false`);
  console.log(
    `  roles with an attachment grant = ${uploadRoles.join(", ") || "(none)"} -> (none)`,
  );
  if (!opts.apply) {
    console.log("  (dry run — re-run with --apply to write this to Stream)");
    return true;
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = `${BACKUP_DIR}/channel-type-${name}-${Date.now()}.json`;
  writeFileSync(backupPath, JSON.stringify(before, null, 2));
  console.log(`  backup             = ${backupPath}`);

  await client.updateChannelType(name, {
    uploads: false,
    grants: withoutUploadGrant(before.grants),
  });

  const after = await client.getChannelType(name);
  const remaining = grantedUploadRoles(after.grants);
  if (after.uploads !== false || remaining.length > 0) {
    console.error(
      `  ❌ ${name} still allows uploads (uploads=${after.uploads}, roles=${remaining.join(", ") || "none"})`,
    );
    return false;
  }
  console.log(`  ✅ ${name} is text-only.`);
  return true;
}

export async function ensureChatTextOnly(opts: Options): Promise<number> {
  if (!isStreamConfigured()) {
    console.error(
      "Stream is not configured — set STREAM_API_KEY and STREAM_API_SECRET",
    );
    return 1;
  }
  for (const name of CHANNEL_TYPES) {
    if (!(await ensureChannelType(name, opts))) return 1;
  }
  return 0;
}

if (process.argv[1]?.endsWith("ensure-chat-text-only.ts")) {
  ensureChatTextOnly(parseArgs(process.argv))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
