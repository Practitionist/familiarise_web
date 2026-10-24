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
import {
  END_USER_ROLES,
  UNUSED_CALL_TYPES,
  shouldStripFromUnusedCallType,
} from "../../lib/stream/control-plane-contract";

const BACKUP_DIR = ".stream-backups";

export interface HardenUnusedOptions {
  apply: boolean;
}

function parseArgs(argv: string[]): HardenUnusedOptions {
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
    const kept = held.filter((perm) => !shouldStripFromUnusedCallType(perm));
    if (kept.length === held.length) continue;
    removals.push(
      `  ${typeName}/${role}: -${held.length - kept.length} (${held
        .filter((p) => shouldStripFromUnusedCallType(p))
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
      .filter((perm) => shouldStripFromUnusedCallType(perm))
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

export async function hardenUnusedCallTypes(
  opts: HardenUnusedOptions,
): Promise<number> {
  const client = getStreamVideoClient();

  if ((UNUSED_CALL_TYPES as readonly string[]).includes(STREAM_CALL_TYPE)) {
    console.error(
      `\n🚨 ${STREAM_CALL_TYPE} is the type this app USES and is in the strip list.` +
        `\n   Refusing — this would lock every user out of every call.`,
    );
    return 1;
  }

  let changedTypes = 0;

  for (const typeName of UNUSED_CALL_TYPES) {
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
  hardenUnusedCallTypes(parseArgs(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("Failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
