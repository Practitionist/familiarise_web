/**
 * Unified Stream configuration orchestrator.
 *
 * Runs:
 *   1. ensureAppSettings (`guest_user_creation_disabled: true`, `enable_hook_payload_compression: false`)
 *   2. ensureCallTypeGrants (`default` role grant hardening)
 *   3. hardenUnusedCallTypes (`audio_room`, `livestream`, `development` reach & billable strip)
 *   4. ensureDefaultCallTypeSettings (`session.inactivity_timeout_seconds: 300` on `default`)
 *
 * Usage:
 *   npx tsx scripts/stream/ensure.ts
 *   npx tsx scripts/stream/ensure.ts --apply --confirm-join-route-deployed
 */
import "dotenv/config";
import { getStreamVideoClient, isStreamConfigured } from "@/lib/stream-client";
import { STREAM_CALL_TYPE } from "@/lib/stream/call-cid";
import { ensureAppSettings } from "./ensure-app-settings";
import { ensureCallTypeGrants } from "./ensure-call-type-grants";
import { hardenUnusedCallTypes } from "./harden-unused-call-types";

export const TARGET_INACTIVITY_TIMEOUT_SECONDS = 300;

export interface EnsureOptions {
  apply: boolean;
  deployConfirmed: boolean;
}

function parseArgs(argv: string[]): EnsureOptions {
  return {
    apply: argv.includes("--apply"),
    deployConfirmed:
      argv.includes("--routes-are-deployed") ||
      argv.includes("--join-route-is-deployed") ||
      argv.includes("--confirm-join-route-deployed"),
  };
}

export async function ensureDefaultCallTypeSettings(opts: {
  apply: boolean;
}): Promise<number> {
  if (!isStreamConfigured()) {
    console.error(
      "Stream is not configured — set STREAM_API_KEY and STREAM_API_SECRET",
    );
    return 1;
  }

  const client = getStreamVideoClient();
  const before = await client.video.getCallType({ name: STREAM_CALL_TYPE });
  const currentTimeout = before.settings?.session?.inactivity_timeout_seconds;

  console.log(`\nCall type '${STREAM_CALL_TYPE}' session settings — current:`);
  console.log(
    `  session.inactivity_timeout_seconds = ${currentTimeout ?? "(unset)"}`,
  );

  if (currentTimeout === TARGET_INACTIVITY_TIMEOUT_SECONDS) {
    console.log(
      `\n✅ session.inactivity_timeout_seconds is already ${TARGET_INACTIVITY_TIMEOUT_SECONDS} — no change.`,
    );
    return 0;
  }

  console.log(
    `\nPending change: session.inactivity_timeout_seconds: ${currentTimeout ?? "(unset)"} -> ${TARGET_INACTIVITY_TIMEOUT_SECONDS}`,
  );

  if (!opts.apply) {
    console.log("\n(dry run — re-run with --apply to write this to Stream)");
    return 0;
  }

  await client.video.updateCallType({
    name: STREAM_CALL_TYPE,
    settings: {
      session: {
        ...before.settings?.session,
        inactivity_timeout_seconds: TARGET_INACTIVITY_TIMEOUT_SECONDS,
      },
    },
  });

  const after = await client.video.getCallType({ name: STREAM_CALL_TYPE });
  if (
    after.settings?.session?.inactivity_timeout_seconds !==
    TARGET_INACTIVITY_TIMEOUT_SECONDS
  ) {
    console.error(
      `\n🚨 Stream did not store session.inactivity_timeout_seconds = ${TARGET_INACTIVITY_TIMEOUT_SECONDS} (read back ${after.settings?.session?.inactivity_timeout_seconds}).`,
    );
    return 1;
  }

  console.log(
    `\n✅ session.inactivity_timeout_seconds = ${TARGET_INACTIVITY_TIMEOUT_SECONDS}, verified on '${STREAM_CALL_TYPE}'.`,
  );
  return 0;
}

export async function ensureStreamConfig(opts: EnsureOptions): Promise<number> {
  console.log("=== [1/4] App Settings ===");
  const appCode = await ensureAppSettings({ apply: opts.apply });
  if (appCode !== 0) return appCode;

  console.log("\n=== [2/4] Default Call Type Grants ===");
  const grantsCode = await ensureCallTypeGrants({
    apply: opts.apply,
    restore: false,
    deployConfirmed: opts.deployConfirmed,
  });
  if (grantsCode !== 0) return grantsCode;

  console.log("\n=== [3/4] Unused Call Types Hardening ===");
  const hardenCode = await hardenUnusedCallTypes({ apply: opts.apply });
  if (hardenCode !== 0) return hardenCode;

  console.log("\n=== [4/4] Default Call Type Session Settings ===");
  const settingsCode = await ensureDefaultCallTypeSettings({
    apply: opts.apply,
  });
  if (settingsCode !== 0) return settingsCode;

  return 0;
}

if (require.main === module) {
  ensureStreamConfig(parseArgs(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("Failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
