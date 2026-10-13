/**
 * Configure Stream app-level settings (`guest_user_creation_disabled`,
 * `enable_hook_payload_compression`) with a pre-image backup and no-op probe.
 *
 *   npx tsx scripts/stream/ensure-app-settings.ts
 *   npx tsx scripts/stream/ensure-app-settings.ts --apply
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import type { AppResponseFields } from "@stream-io/node-sdk";
import { getStreamVideoClient, isStreamConfigured } from "@/lib/stream-client";
import { canonical, diffFingerprints } from "@/lib/stream/config-fingerprint";

const BACKUP_DIR = ".stream-backups";

const TARGET = {
  guestUserCreationDisabled: true,
  enableHookPayloadCompression: false,
} as const;

interface Options {
  apply: boolean;
}

function parseArgs(argv: string[]): Options {
  return { apply: argv.includes("--apply") };
}

function fingerprint(app: AppResponseFields): Record<string, string> {
  return {
    event_hooks: canonical(app.event_hooks),
    webhook_events: canonical(app.webhook_events),
    webhook_url: canonical(app.webhook_url),
    permission_version: canonical(app.permission_version),
    revoke_tokens_issued_before: canonical(app.revoke_tokens_issued_before),
    multi_tenant_enabled: canonical(app.multi_tenant_enabled),
    moderation_enabled: canonical(app.moderation_enabled),
    cdn_expiration_seconds: canonical(app.cdn_expiration_seconds),
    geofences: canonical(app.geofences),
    file_upload_config: canonical(app.file_upload_config),
    image_upload_config: canonical(app.image_upload_config),
    push_notifications: canonical(app.push_notifications),
  };
}

export async function ensureAppSettings(opts: Options): Promise<number> {
  if (!isStreamConfigured()) {
    console.error(
      "Stream is not configured — set STREAM_API_KEY and STREAM_API_SECRET",
    );
    return 1;
  }

  const client = getStreamVideoClient();
  const before = (await client.getApp()).app;

  console.log("App settings — current:");
  console.log(
    `  guest_user_creation_disabled    = ${before.guest_user_creation_disabled}`,
  );
  console.log(
    `  enable_hook_payload_compression = (write-only, not readable back)`,
  );
  console.log(
    `  event_hooks                     = ${before.event_hooks?.length ?? 0} hook(s)`,
  );

  if (
    before.guest_user_creation_disabled === TARGET.guestUserCreationDisabled
  ) {
    console.log(
      "\n✅ guest_user_creation_disabled is already true — no change, and no write.",
    );
    return 0;
  }

  console.log("\nPending changes:");
  console.log(
    `  guest_user_creation_disabled: ${before.guest_user_creation_disabled} -> ${TARGET.guestUserCreationDisabled}`,
  );
  console.log(
    `  enable_hook_payload_compression: (unknown) -> ${TARGET.enableHookPayloadCompression}  [sent, unverifiable]`,
  );

  if (!opts.apply) {
    console.log("\n(dry run — re-run with --apply to write this to Stream)");
    return 0;
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/:/g, "-");
  const preImagePath = `${BACKUP_DIR}/app-settings.${stamp}.json`;
  writeFileSync(preImagePath, JSON.stringify(before, null, 2));
  console.log(`\nPre-image written to ${preImagePath}`);

  console.log("Probing whether updateApp merges or replaces…");
  const fpBefore = fingerprint(before);

  if (typeof before.moderation_enabled !== "boolean") {
    console.error(
      `\n🛑 Refusing to apply — cannot build a meaningful no-op probe.` +
        `\n   Pre-image: ${preImagePath}\n`,
    );
    return 1;
  }

  await client.updateApp({ moderation_enabled: before.moderation_enabled });
  const probed = (await client.getApp()).app;
  const probeDrift = diffFingerprints(fpBefore, fingerprint(probed));

  if (probeDrift.length > 0) {
    console.error(
      `\n🚨 updateApp REPLACED configuration it was not given.` +
        `\n   Fields that changed on a no-op write: ${probeDrift.join(", ")}` +
        `\n   Restore from the pre-image at: ${preImagePath}\n`,
    );
    return 1;
  }
  console.log("  probe clean — top-level fields merge.");

  await client.updateApp({
    guest_user_creation_disabled: TARGET.guestUserCreationDisabled,
    enable_hook_payload_compression: TARGET.enableHookPayloadCompression,
  });

  const after = (await client.getApp()).app;
  const drift = diffFingerprints(fpBefore, fingerprint(after));

  if (drift.length > 0) {
    console.error(
      `\n🚨 The real write changed configuration it was not given: ${drift.join(", ")}` +
        `\n   Restore from ${preImagePath}\n`,
    );
    return 1;
  }

  if (after.guest_user_creation_disabled !== TARGET.guestUserCreationDisabled) {
    console.error(
      `\n🚨 Stream did not store guest_user_creation_disabled — it reads back as` +
        ` ${after.guest_user_creation_disabled}.\n`,
    );
    return 1;
  }

  console.log(
    "\n✅ guest_user_creation_disabled = true, verified against Stream.",
  );
  return 0;
}

if (require.main === module) {
  ensureAppSettings(parseArgs(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("Failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
