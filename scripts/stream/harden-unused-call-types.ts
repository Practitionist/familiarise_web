/**
 * Strip end-user reach and billable permissions from unused built-in Stream
 * call types (`livestream`, `audio_room`, `development`).
 *
 *   npx tsx scripts/stream/harden-unused-call-types.ts
 *   npx tsx scripts/stream/harden-unused-call-types.ts --apply
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { getStreamVideoClient } from "@/lib/stream-client";
import { STREAM_CALL_TYPE } from "../../lib/stream/call-cid";

const BACKUP_DIR = ".stream-backups";

export const UNUSED_TYPES = [
  "livestream",
  "audio_room",
  "development",
] as const;

export const END_USER_ROLES = [
  "user",
  "guest",
  "anonymous",
  "speaker",
  "host",
  "call_member",
];

export const REACH_PERMISSIONS = [
  "create-call",
  "create-call-any-team",
  "join-call",
  "join-call-any-team",
  "join-backstage",
  "join-backstage-any-team",
  "join-ended-call",
  "join-ended-call-any-team",
];

export const BILLABLE_PERMISSIONS = [
  "start-recording",
  "start-frame-recording",
  "start-transcription",
  "start-closed-captions",
  "start-broadcasting",
];

const STRIP = new Set([...REACH_PERMISSIONS, ...BILLABLE_PERMISSIONS]);

interface Options {
  apply: boolean;
}

function parseArgs(argv: string[]): Options {
  return { apply: argv.includes("--apply") };
}

async function hardenOne(
  client: ReturnType<typeof getStreamVideoClient>,
  typeName: string,
  apply: boolean,
): Promise<{ changed: boolean; failed: boolean }> {
  const before = await client.video.getCallType({ name: typeName });
  const grants: Record<string, string[]> = { ...before.grants };

  const removals: string[] = [];
  for (const role of END_USER_ROLES) {
    const held = grants[role];
    if (!held) continue;
    const kept = held.filter((perm) => !STRIP.has(perm));
    if (kept.length === held.length) continue;
    removals.push(
      `  ${typeName}/${role}: -${held.length - kept.length} (${held
        .filter((p) => STRIP.has(p))
        .join(", ")})`,
    );
    grants[role] = kept;
  }

  if (removals.length === 0) {
    console.log(`✅ ${typeName} — already hardened`);
    return { changed: false, failed: false };
  }

  console.log(`\n${typeName}:`);
  for (const line of removals) console.log(line);
  if (!apply) return { changed: true, failed: false };

  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/:/g, "-");
  const preImage = `${BACKUP_DIR}/call-type-${typeName}.grants.${stamp}.json`;
  writeFileSync(preImage, JSON.stringify(before.grants, null, 2));
  console.log(`  pre-image → ${preImage}`);

  await client.video.updateCallType({ name: typeName, grants });

  const after = await client.video.getCallType({ name: typeName });
  const leaked = END_USER_ROLES.flatMap((role) =>
    (after.grants[role] ?? [])
      .filter((perm) => STRIP.has(perm))
      .map((perm) => `${role}:${perm}`),
  );
  if (leaked.length > 0) {
    console.error(
      `  🚨 still granted after the write: ${leaked.join(", ")}` +
        `\n     restore from ${preImage}`,
    );
    return { changed: true, failed: true };
  }
  console.log(`  ✅ verified`);
  return { changed: true, failed: false };
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const client = getStreamVideoClient();

  if ((UNUSED_TYPES as readonly string[]).includes(STREAM_CALL_TYPE)) {
    console.error(
      `\n🚨 ${STREAM_CALL_TYPE} is the type this app USES and is in the strip list.` +
        `\n   Refusing — this would lock every user out of every call.`,
    );
    return 1;
  }

  let changedTypes = 0;

  for (const typeName of UNUSED_TYPES) {
    const { changed, failed } = await hardenOne(client, typeName, opts.apply);
    if (failed) return 1;
    if (changed) changedTypes++;
  }

  if (changedTypes === 0) {
    console.log("\nNothing to do.");
    return 0;
  }
  if (!opts.apply) {
    console.log(
      `\n(dry run — re-run with --apply to write these to ${changedTypes} call type(s))`,
    );
  }
  return 0;
}

if (process.argv[1] && /harden-unused-call-types/.test(process.argv[1])) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("Failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
